import {
  bleLog,
  formatMac,
  sleep,
  errMsg,
  withTimeout,
  CONNECT_TIMEOUT_MS,
  DISCOVERY_TIMEOUT_MS,
  POST_DISCOVERY_QUIESCE_MS,
} from '../types.js';
import type { Adapter, Device } from './dbus.js';
import { startDiscoverySafe, removeDevice, stopDiscoveryAndQuiesce } from './discovery.js';
import { startPeerFreshnessTracker } from './freshness.js';
import { isDeviceObjectGone } from './device-object.js';

export interface ConnectRecoveryContext {
  btAdapter: Adapter;
  mac: string;
  initialDevice: Device;
  maxRetries: number;
  bleAdapter?: string;
  /**
   * Do not stop BlueZ discovery between attempts: the peer's Device1 object
   * only exists while a discovery session is active (#297). Normally left
   * unset; the loop arms it by itself when it sees the object disappear.
   */
  keepDiscoveryDuringConnect?: boolean;
}

/**
 * Connect to a BLE device with recovery for BlueZ-specific failures.
 * On each failed attempt: disconnect -> RemoveDevice -> re-discover -> quiesce -> retry.
 * Returns the (possibly refreshed) Device reference.
 */
export async function connectWithRecovery(ctx: ConnectRecoveryContext): Promise<Device> {
  let { btAdapter } = ctx;
  const { mac, maxRetries, bleAdapter } = ctx;
  const formattedMac = formatMac(mac);
  let device = ctx.initialDevice;
  // RSSI freshness re-discovery is a one-shot defense per call: if the peer
  // already looks dark, we re-discover once. Repeating it on every retry just
  // burns the budget on a peer that never came back; let the outer loop pick
  // the next cooldown instead.
  let rssiRediscoverUsed = false;
  // Armed either by the caller or, reactively, the first time BlueZ is caught
  // deleting the peer's Device1 object while discovery is stopped (#297). Off
  // by default, so every other node-ble user takes the identical code path.
  let keepDiscovery = ctx.keepDiscoveryDuringConnect === true;
  let sawObjectGone = false;
  // Long-lived PropertiesChanged subscription on the current device proxy so
  // every received advertisement updates the freshness clock. The tracker is
  // rebound when the catch branch swaps the device reference.
  let tracker = startPeerFreshnessTracker(device);

  try {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // Skip the dying-peer connect attempt: a missing or 127-sentinel RSSI
        // OR no PropertiesChanged for RSSI within RSSI_FRESHNESS_MS means
        // BlueZ has not heard a fresh advertisement, and connect will stall
        // inside GATT discovery (#143). Force one re-discovery to either
        // refresh the cached props or fail fast.
        if (!(await tracker.isFresh())) {
          if (rssiRediscoverUsed) {
            throw new Error(`Peer ${formattedMac} not advertising (RSSI stale after re-discovery)`);
          }
          rssiRediscoverUsed = true;
          bleLog.warn(`Peer ${formattedMac} RSSI stale, re-discovering before connect...`);
          // Inner try wraps only the D-Bus rediscovery itself so its failures
          // map to "skipped connect to dying peer". The post-rediscovery
          // freshness check throws its own clear message outside the wrap.
          try {
            tracker.stop();
            const result = await startDiscoverySafe(btAdapter, bleAdapter);
            if (result) btAdapter = result;
            device = await withTimeout(
              btAdapter.waitDevice(formattedMac),
              DISCOVERY_TIMEOUT_MS,
              `Device ${formattedMac} not found during RSSI re-discovery`,
            );
            tracker = startPeerFreshnessTracker(device);
            if (keepDiscovery) {
              await sleep(POST_DISCOVERY_QUIESCE_MS);
            } else {
              await stopDiscoveryAndQuiesce(btAdapter);
            }
          } catch (rssiErr: unknown) {
            throw new Error(`Skipped connect to dying peer ${formattedMac}: ${errMsg(rssiErr)}`);
          }
          if (!(await tracker.isFresh())) {
            throw new Error(`Peer ${formattedMac} still not advertising after re-discovery`);
          }
        }

        const t0 = Date.now();
        bleLog.debug(`Connect attempt ${attempt + 1}/${maxRetries + 1}...`);
        await withTimeout(device.connect(), CONNECT_TIMEOUT_MS, 'Connection timed out');
        bleLog.debug(`Connected (took ${Date.now() - t0}ms)`);
        if (keepDiscovery) {
          // Restore the "no discovery during GATT" invariant the callers rely
          // on. Safe now: BlueZ does not drop a device object while it is
          // Connected, which is what let this peer be reached at all (#297).
          bleLog.debug('Connected with discovery active; stopping discovery for the GATT phase');
          await stopDiscoveryAndQuiesce(btAdapter);
        }
        return device;
      } catch (err: unknown) {
        const msg = errMsg(err);
        if (isDeviceObjectGone(err)) sawObjectGone = true;
        if (sawObjectGone && !keepDiscovery) {
          keepDiscovery = true;
          bleLog.warn(
            `BlueZ removed the org.bluez.Device1 object for ${formattedMac} while discovery was stopped, so this peer is only visible while scanning is active. Retrying with discovery left running (#297).`,
          );
        }
        if (attempt >= maxRetries) {
          // Latched, not just the last error: once BlueZ has been caught
          // dropping the object, that is the story worth telling even if the
          // final attempt happened to time out instead.
          if (sawObjectGone) {
            throw new Error(
              `Connection failed after ${maxRetries + 1} attempts: BlueZ keeps removing the D-Bus object for ${formattedMac}, so no GATT connection can be opened. The scale advertises but does not accept connections (broadcast only or non-discoverable). Last error: ${msg}`,
            );
          }
          throw new Error(`Connection failed after ${maxRetries + 1} attempts: ${msg}`);
        }

        const delay = 1000 + attempt * 500;
        bleLog.warn(
          `Connect error: ${msg}. Retrying (${attempt + 1}/${maxRetries}) in ${delay}ms...`,
        );

        // 1. Disconnect (best-effort)
        try {
          bleLog.debug('Disconnecting before retry...');
          await device.disconnect();
          bleLog.debug('Disconnect OK');
        } catch {
          bleLog.debug('Disconnect failed (ignored)');
        }

        // 2. Purge stale D-Bus proxy
        await removeDevice(btAdapter, mac);

        // 3. Progressive delay
        await sleep(delay);

        // 4. Re-discover and acquire fresh device reference + rebind tracker
        tracker.stop();
        try {
          const result = await startDiscoverySafe(btAdapter, bleAdapter);
          if (result) btAdapter = result;
          device = await withTimeout(
            btAdapter.waitDevice(formattedMac),
            DISCOVERY_TIMEOUT_MS,
            `Device ${formattedMac} not found during retry`,
          );

          if (keepDiscovery) {
            bleLog.debug('Leaving discovery running for the next connect attempt (#297)');
          } else {
            try {
              await btAdapter.stopDiscovery();
            } catch {
              bleLog.debug('stopDiscovery failed during retry (ignored)');
            }
          }
          await sleep(POST_DISCOVERY_QUIESCE_MS);
        } catch (retryErr: unknown) {
          bleLog.debug(`Re-discovery during retry failed: ${errMsg(retryErr)}`);
          // Fallback: try to get device directly without re-discovery
          try {
            device = await btAdapter.getDevice(formattedMac);
          } catch {
            throw new Error(
              `Connection failed and device re-acquisition failed: ${errMsg(retryErr)}`,
            );
          }
        }
        tracker = startPeerFreshnessTracker(device);
      }
    }

    throw new Error('Connection failed');
  } finally {
    tracker.stop();
  }
}
