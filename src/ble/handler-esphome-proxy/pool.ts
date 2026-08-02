import type { BleDeviceInfo } from '../../interfaces/scale-adapter.js';
import type { EsphomeProxyConfig } from '../../config/schema.js';
import { bleLog, errMsg } from '../types.js';
import {
  createEsphomeClient,
  waitForConnected,
  safeDisconnect,
  type EsphomeClient,
  type EsphomeBleAdvertisement,
} from './client.js';
import { toBleDeviceInfo, formatMacAddress } from './advert.js';
import { openGattSession, type GattSession } from './gatt.js';

/** A sighting kept fresh for this long counts toward proxy selection. */
const SIGHTING_TTL_MS = 60_000;

/** How often the advertisement-liveness sweep runs. */
const LIVENESS_CHECK_MS = 30_000;

/**
 * Backoff after a rebuild. The first rung must exceed LIVENESS_CHECK_MS, or the
 * recomputed deadline lands on the next sweep tick and the rung is a no-op.
 */
const REBUILD_BACKOFF_MS = [60_000, 120_000, 240_000, 300_000];

/**
 * Successful rebuilds that still produced no advertisement before giving up.
 * Guards the documented case where rebuilding cannot help: a proxy already
 * adopted by Home Assistant serves only one advertisement subscription, so we
 * would reconnect cleanly and still hear nothing, forever.
 */
const MAX_INEFFECTIVE_REBUILDS = 3;

export interface ProxyEndpoint {
  id: string; // `${host}:${port}`
  host: string;
  port: number;
  encryption_key?: string | null;
  password?: string | null;
  client_info: string;
}

interface Sighting {
  rssi: number;
  ts: number;
}

type AdvertCb = (info: BleDeviceInfo, mac: string) => void;

function endpointsFromConfig(config: EsphomeProxyConfig): ProxyEndpoint[] {
  const mk = (e: {
    host: string;
    port: number;
    encryption_key?: string | null;
    password?: string | null;
    client_info: string;
  }): ProxyEndpoint => ({
    id: `${e.host}:${e.port}`,
    host: e.host,
    port: e.port,
    encryption_key: e.encryption_key,
    password: e.password,
    client_info: e.client_info,
  });
  return [mk(config), ...(config.additional_proxies ?? []).map(mk)];
}

/**
 * Owns one ESPHome client per configured proxy, aggregates BLE advertisements
 * across all of them, and tracks which proxy last saw each MAC (with RSSI) so
 * GATT connects can be routed to the proxy most likely to reach the scale.
 */
export class EsphomeProxyPool {
  private endpoints: ProxyEndpoint[];
  private clients = new Map<string, EsphomeClient>();
  private adHandlers = new Map<string, (ad: EsphomeBleAdvertisement) => void>();
  // macLc -> proxyId -> latest sighting
  private sightings = new Map<string, Map<string, Sighting>>();
  // macLc -> BLE address type (public/random) last reported in an advertisement.
  // ESPHome's V3 connect request requires this; a device's type is stable, so any
  // proxy that saw it teaches the whole pool. Kept in lockstep with `sightings`.
  private addressTypes = new Map<string, number>();
  private subscribers = new Set<AdvertCb>();
  private started = false;

  // --- advertisement liveness (#303) ---
  /** proxyId -> timestamp of the last advertisement seen from it. */
  private lastAdAt = new Map<string, number>();
  /** proxyId -> open or opening GATT sessions; never tear one of these down. */
  private gattInFlight = new Map<string, number>();
  private rebuilding = new Set<string>();
  private rebuildAttempts = new Map<string, number>();
  private ineffectiveRebuilds = new Map<string, number>();
  private livenessTimer: ReturnType<typeof setInterval> | null = null;
  private readonly advertisementTimeoutMs: number;
  private readonly livenessEnabled: boolean;

  constructor(config: EsphomeProxyConfig, opts: { liveness?: boolean } = {}) {
    this.endpoints = endpointsFromConfig(config);
    this.advertisementTimeoutMs = (config.advertisement_timeout ?? 0) * 1000;
    // One-shot pools (npm run scan, a single read) are bounded by their own
    // caller, so a liveness timer there would only leak a handle.
    this.livenessEnabled = opts.liveness !== false;
  }

  /**
   * Register that a GATT session is opening or open on this proxy. The sweep
   * must never tear down a client while a session is bound to its connection,
   * and an active session is itself proof the transport is alive.
   */
  noteGattStart(proxyId: string): void {
    this.gattInFlight.set(proxyId, (this.gattInFlight.get(proxyId) ?? 0) + 1);
  }

  noteGattEnd(proxyId: string): void {
    const n = (this.gattInFlight.get(proxyId) ?? 1) - 1;
    if (n <= 0) this.gattInFlight.delete(proxyId);
    else this.gattInFlight.set(proxyId, n);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    for (const ep of this.endpoints) {
      const client = await createEsphomeClient({
        host: ep.host,
        port: ep.port,
        encryption_key: ep.encryption_key,
        password: ep.password,
        client_info: ep.client_info,
        additional_proxies: [],
        advertisement_timeout: 0,
      } as EsphomeProxyConfig);
      const handler = (ad: EsphomeBleAdvertisement): void => this.onAd(ep.id, ad);
      client.on('ble', handler);
      this.clients.set(ep.id, client);
      this.adHandlers.set(ep.id, handler);
      await waitForConnected(client, ep.id);
      this.lastAdAt.set(ep.id, Date.now());
      bleLog.info(`ESPHome proxy connected at ${ep.id}`);
    }
    if (this.livenessEnabled && this.advertisementTimeoutMs > 0) {
      bleLog.info(
        `ESPHome advertisement watchdog armed (${this.advertisementTimeoutMs / 1000}s of silence rebuilds the client)`,
      );
      this.livenessTimer = setInterval(() => void this.sweepLiveness(), LIVENESS_CHECK_MS);
      this.livenessTimer.unref?.();
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    // First, not last: rebuildClient re-checks `started` after each await, and a
    // late clear leaves a window where a rebuilt client is inserted into an
    // already-cleared map, never disconnected, and keeps its own reconnect loop
    // and timers alive for the rest of the process.
    this.started = false;
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = null;
    }
    for (const [id, client] of this.clients) {
      const handler = this.adHandlers.get(id);
      if (handler) client.removeListener('ble', handler as (...args: unknown[]) => void);
      await safeDisconnect(client);
    }
    this.clients.clear();
    this.adHandlers.clear();
    this.sightings.clear();
    this.addressTypes.clear();
    this.lastAdAt.clear();
    this.gattInFlight.clear();
    this.rebuilding.clear();
    this.rebuildAttempts.clear();
    this.ineffectiveRebuilds.clear();
  }

  /**
   * Rebuild any proxy client that has not delivered a single advertisement for
   * `advertisement_timeout`. A home proxy always sees some BLE traffic, so a
   * long silence means the transport died rather than that the house is quiet
   * (#303, #281).
   */
  private async sweepLiveness(): Promise<void> {
    const now = Date.now();
    for (const ep of this.endpoints) {
      if (!this.started) return;
      if (this.rebuilding.has(ep.id)) continue;
      if ((this.ineffectiveRebuilds.get(ep.id) ?? 0) >= MAX_INEFFECTIVE_REBUILDS) continue;
      // An open or opening GATT session binds its charMap and notify listeners
      // to this client's connection, and is itself proof of life.
      if ((this.gattInFlight.get(ep.id) ?? 0) > 0) {
        this.lastAdAt.set(ep.id, now);
        continue;
      }
      const last = this.lastAdAt.get(ep.id) ?? now;
      const silentMs = now - last;
      const rung = Math.min(this.rebuildAttempts.get(ep.id) ?? 0, REBUILD_BACKOFF_MS.length - 1);
      const threshold = Math.max(this.advertisementTimeoutMs, REBUILD_BACKOFF_MS[rung]);
      if (silentMs < threshold) continue;
      bleLog.warn(
        `ESPHome proxy ${ep.id}: no BLE advertisement for ${Math.round(silentMs / 1000)}s ` +
          `(threshold ${Math.round(threshold / 1000)}s). Rebuilding the client (#303).`,
      );
      await this.rebuildClient(ep);
    }
  }

  private async rebuildClient(ep: ProxyEndpoint): Promise<void> {
    this.rebuilding.add(ep.id);
    try {
      const old = this.clients.get(ep.id);
      const oldHandler = this.adHandlers.get(ep.id);
      if (old && oldHandler) {
        old.removeListener('ble', oldHandler as (...args: unknown[]) => void);
      }
      // safeDisconnect now guarantees connection.disconnect(), which releases
      // the node's single advertisement-subscription slot before we reconnect.
      if (old) await safeDisconnect(old);
      this.clients.delete(ep.id);
      this.adHandlers.delete(ep.id);
      if (!this.started) return;

      const client = await createEsphomeClient({
        host: ep.host,
        port: ep.port,
        encryption_key: ep.encryption_key,
        password: ep.password,
        client_info: ep.client_info,
        additional_proxies: [],
        advertisement_timeout: 0,
      } as EsphomeProxyConfig);
      const handler = (ad: EsphomeBleAdvertisement): void => this.onAd(ep.id, ad);
      client.on('ble', handler);
      await waitForConnected(client, ep.id);
      if (!this.started) {
        await safeDisconnect(client);
        return;
      }
      this.clients.set(ep.id, client);
      this.adHandlers.set(ep.id, handler);
      this.lastAdAt.set(ep.id, Date.now());
      this.rebuildAttempts.set(ep.id, (this.rebuildAttempts.get(ep.id) ?? 0) + 1);
      // Counted until an advertisement actually arrives; onAd clears it. A
      // rebuild that reconnects cleanly and still hears nothing is the
      // adopted-proxy case, where retrying forever helps nobody.
      this.ineffectiveRebuilds.set(ep.id, (this.ineffectiveRebuilds.get(ep.id) ?? 0) + 1);
      if ((this.ineffectiveRebuilds.get(ep.id) ?? 0) >= MAX_INEFFECTIVE_REBUILDS) {
        bleLog.warn(
          `ESPHome proxy ${ep.id}: rebuilt ${MAX_INEFFECTIVE_REBUILDS} times without a single ` +
            'advertisement. Giving up on the watchdog for this proxy. If it is adopted by Home ' +
            'Assistant, it serves only one advertisement subscription and cannot be shared.',
        );
      }
      bleLog.info(`ESPHome proxy ${ep.id} rebuilt after advertisement silence`);
    } catch (err) {
      this.rebuildAttempts.set(ep.id, (this.rebuildAttempts.get(ep.id) ?? 0) + 1);
      bleLog.warn(
        `ESPHome proxy ${ep.id} rebuild failed: ${errMsg(err)}. Will retry with backoff.`,
      );
      this.lastAdAt.set(ep.id, Date.now());
    } finally {
      this.rebuilding.delete(ep.id);
    }
  }

  /** Subscribe to merged advertisements from all proxies. Returns unsubscribe. */
  onAdvertisement(cb: AdvertCb): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  getClient(proxyId: string): EsphomeClient | null {
    return this.clients.get(proxyId) ?? null;
  }

  /**
   * Open a GATT session to `mac`, trying proxies best-first (the one that saw
   * it most recently, then blind fallbacks). Throws only when every proxy
   * failed.
   */
  async connectGatt(mac: string): Promise<GattSession> {
    const order = this.proxyOrderFor(mac);
    const addressType = this.addressTypes.get(mac.toLowerCase());
    const errors: string[] = [];
    for (const id of order) {
      const client = this.clients.get(id);
      if (!client) continue;
      // Hold the liveness sweep off this proxy for the whole session: its
      // charMap and notify listeners are bound to this client's connection, so
      // a rebuild underneath would silently break an in-progress weigh-in.
      this.noteGattStart(id);
      try {
        const session = await openGattSession(client, mac, addressType);
        const close = session.close.bind(session);
        let released = false;
        session.close = async (): Promise<void> => {
          if (!released) {
            released = true;
            this.noteGattEnd(id);
          }
          await close();
        };
        return session;
      } catch (e) {
        this.noteGattEnd(id);
        errors.push(`${id}: ${errMsg(e)}`);
      }
    }
    throw new Error(
      `ESPHome GATT connect failed for ${mac} on all proxies: ${errors.join('; ') || 'no proxy available'}`,
    );
  }

  /** BLE address type last seen for `mac`, or undefined if no advert reported one. */
  addressTypeFor(mac: string): number | undefined {
    return this.addressTypes.get(mac.toLowerCase());
  }

  /** Proxy that most recently saw `mac` (RSSI tiebreak) within the TTL, or null. */
  pickProxyFor(mac: string): string | null {
    const fresh = this.freshSightings(mac);
    return fresh.length > 0 ? fresh[0].id : null;
  }

  /**
   * Proxies ranked best-first for reaching `mac`: those that saw it within the
   * TTL ordered by most-recent sighting (strongest RSSI breaks ties), followed
   * by any remaining endpoints in declaration order as blind fallbacks (used by
   * connectGatt to still attempt a connection when nothing has been seen).
   */
  proxyOrderFor(mac: string): string[] {
    const ranked = this.freshSightings(mac).map((f) => f.id);
    const seen = new Set(ranked);
    for (const ep of this.endpoints) {
      if (!seen.has(ep.id)) ranked.push(ep.id);
    }
    return ranked;
  }

  private freshSightings(mac: string): Array<{ id: string; rssi: number; ts: number }> {
    const perProxy = this.sightings.get(mac.toLowerCase());
    if (!perProxy) return [];
    const now = Date.now();
    const fresh: Array<{ id: string; rssi: number; ts: number }> = [];
    for (const [id, s] of perProxy) {
      if (now - s.ts <= SIGHTING_TTL_MS) fresh.push({ id, rssi: s.rssi, ts: s.ts });
    }
    fresh.sort((a, b) => (b.ts !== a.ts ? b.ts - a.ts : b.rssi - a.rssi));
    return fresh;
  }

  /** Drop sightings past the TTL so the map cannot grow without bound. */
  private evictStale(now: number): void {
    for (const [mac, perProxy] of this.sightings) {
      for (const [id, s] of perProxy) {
        if (now - s.ts > SIGHTING_TTL_MS) perProxy.delete(id);
      }
      if (perProxy.size === 0) {
        this.sightings.delete(mac);
        // Keep the address-type cache from outliving the sightings it belongs to.
        this.addressTypes.delete(mac);
      }
    }
  }

  private onAd(proxyId: string, ad: EsphomeBleAdvertisement): void {
    // Liveness is "is the pipe alive", not "is this advertisement useful", so
    // record it before any filtering.
    this.lastAdAt.set(proxyId, Date.now());
    this.ineffectiveRebuilds.delete(proxyId);
    this.rebuildAttempts.delete(proxyId);
    const mac = formatMacAddress(ad.address);
    if (mac === '00:00:00:00:00:00') return;
    const now = Date.now();
    this.evictStale(now);
    const macLc = mac.toLowerCase();
    let perProxy = this.sightings.get(macLc);
    if (!perProxy) {
      perProxy = new Map();
      this.sightings.set(macLc, perProxy);
    }
    perProxy.set(proxyId, { rssi: ad.rssi, ts: now });
    // Record the BLE address type (public = 0 is valid and falsy, so guard on
    // the type, not truthiness) so connectGatt can satisfy ESPHome's V3 connect.
    if (typeof ad.addressType === 'number') this.addressTypes.set(macLc, ad.addressType);

    const info = toBleDeviceInfo(ad);
    for (const cb of this.subscribers) cb(info, mac);
  }
}
