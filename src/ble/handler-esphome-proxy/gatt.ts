import type { BleChar, BleDevice } from '../shared.js';
import { bleLog, errMsg, normalizeUuid } from '../types.js';
import type { EsphomeClient, EsphomeConnection } from './client.js';
import { macToInt } from './advert.js';
import {
  cccdValueFor,
  esphomeGattPayload,
  esphomeUuidToString,
  findCccdHandle,
  type EsphomeGattServicesResponse,
  type EsphomeNotifyData,
  type EsphomeDeviceConnection,
} from './esphome-gatt-proto.js';

const NOTIFY_EVENT = 'message.BluetoothGATTNotifyDataResponse';
const CONNECTION_EVENT = 'message.BluetoothDeviceConnectionResponse';
const GATT_ERROR_EVENT = 'message.BluetoothGATTErrorResponse';

export interface GattSession {
  /** Normalized-UUID -> BleChar, the shape waitForRawReading() consumes. */
  charMap: Map<string, BleChar>;
  device: BleDevice;
  close(): Promise<void>;
}

interface ConnectResponse extends EsphomeDeviceConnection {
  mtu?: number;
}

/**
 * Connect to `mac` through an ESPHome proxy client, discover its GATT table,
 * and expose it as the UUID-keyed BleChar map + BleDevice that the shared
 * waitForRawReading() seam expects. ESPHome speaks numeric handles and a uint64
 * address; the translation is contained here so adapters stay UUID-based and
 * unchanged.
 *
 * ESPHome's V3 connect request requires the BLE `address_type`; omitting it makes
 * newer firmware reject the connect with "Missing address type" (#215). When the
 * type is known (captured from the advertisement) we try it first; otherwise, and
 * as a fallback when the first attempt fails, we try the other type (public = 0,
 * random = 1).
 */
export async function openGattSession(
  client: EsphomeClient,
  mac: string,
  addressType?: number,
): Promise<GattSession> {
  const conn: EsphomeConnection = client.connection;
  const addr = macToInt(mac);

  const candidates = addressType === undefined ? [0, 1] : [addressType, addressType === 0 ? 1 : 0];
  let connResp: ConnectResponse | undefined;
  let lastErr = 'no connect attempt made';
  for (const type of candidates) {
    try {
      const resp = (await conn.connectBluetoothDeviceService(addr, type)) as ConnectResponse;
      if (resp && resp.connected === true) {
        connResp = resp;
        break;
      }
      lastErr = `connected=false (addr_type=${type})`;
    } catch (e) {
      lastErr = `${errMsg(e)} (addr_type=${type})`;
    }
  }
  if (!connResp) {
    throw new Error(`ESPHome proxy could not connect to ${mac}: ${lastErr}`);
  }
  const services = (await conn.listBluetoothGATTServicesService(
    addr,
  )) as EsphomeGattServicesResponse;

  bleLog.debug(`ESPHome connected to ${mac} (mtu=${connResp.mtu ?? 'unknown'})`);

  let closed = false;

  // The library's sendMessageAwaitResponse() resolves on the FIRST matching
  // response event and does not correlate by address or handle, so two GATT
  // requests in flight at once can swap replies (a descriptor write and a
  // characteristic write both await BluetoothGATTWriteResponse). Adapters do run
  // concurrently with subscribe during startInit, so every request for this
  // session goes through one queue (#252).
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const registered: Array<{ event: string; fn: (m: unknown) => void }> = [];
  const track = (event: string, fn: (m: unknown) => void): (() => void) => {
    conn.on(event, fn);
    registered.push({ event, fn });
    return () => {
      conn.removeListener(event, fn);
      const i = registered.findIndex((r) => r.fn === fn);
      if (i >= 0) registered.splice(i, 1);
    };
  };

  track(GATT_ERROR_EVENT, (raw: unknown) => {
    const m = raw as { address: number; handle: number; error: number };
    if (m.address !== addr) return;
    bleLog.debug(`ESPHome GATT error: handle 0x${m.handle.toString(16)} status=${m.error}`);
  });

  // One log line per unexpected peer address for the whole session: every
  // listener sees every notify event, so a per-listener guard would multiply it
  // by the number of subscribed characteristics.
  const loggedForeignAddresses = new Set<number>();

  const charMap = new Map<string, BleChar>();
  for (const svc of services.servicesList ?? []) {
    for (const ch of svc.characteristicsList ?? []) {
      // The library hands us a pre-decoded `uuid` string; `uuidList` is the
      // raw-shape fallback. Skip entries we cannot identify rather than letting
      // one malformed characteristic throw and abort the whole session (#229).
      const uuid = ch.uuid ? normalizeUuid(ch.uuid) : esphomeUuidToString(ch.uuidList);
      if (!uuid) continue;
      const handle = ch.handle;
      const props = ch.properties;
      const cccdHandle = findCccdHandle(ch);
      bleLog.debug(
        `ESPHome GATT char ${uuid} handle=0x${handle.toString(16)} props=0x${(props ?? 0).toString(16)} cccd=${
          cccdHandle === undefined ? 'none' : `0x${cccdHandle.toString(16)}`
        }`,
      );

      const char: BleChar = {
        async read(): Promise<Buffer> {
          const r = (await serial(() =>
            conn.readBluetoothGATTCharacteristicService(addr, handle),
          )) as {
            data?: string | Uint8Array;
            dataList?: number[];
          };
          return esphomeGattPayload(r);
        },
        async write(data: Buffer, withResponse: boolean): Promise<void> {
          if (closed) return;
          // One atomic characteristic write, matching the native node-ble
          // handler. ESPHome's bluetooth_proxy handles ATT-level fragmentation;
          // splitting here would send N distinct values, not a long write.
          await serial(() =>
            conn.writeBluetoothGATTCharacteristicService(
              addr,
              handle,
              Uint8Array.from(data),
              withResponse,
            ),
          );
        },
        async subscribe(onData: (data: Buffer) => void): Promise<() => void> {
          await serial(() => conn.notifyBluetoothGATTCharacteristicService(addr, handle));
          // Registering with the proxy only routes notifications the ESP32
          // receives; ESP-IDF requires the client to write the CCC descriptor
          // before the peripheral sends any (#252). Register first so a
          // notification fired the instant the CCCD lands is already routed.
          const cccdValue = cccdValueFor(props);
          if (cccdHandle !== undefined && cccdValue !== undefined) {
            try {
              await serial(() =>
                conn.writeBluetoothGATTDescriptorService(addr, cccdHandle, cccdValue),
              );
              bleLog.debug(
                `ESPHome CCCD write handle 0x${cccdHandle.toString(16)} = ${Buffer.from(
                  cccdValue,
                ).toString('hex')} for char 0x${handle.toString(16)}`,
              );
            } catch (e) {
              // A scale that ignores the CCCD still gets the old behaviour.
              bleLog.debug(
                `ESPHome CCCD write failed for char 0x${handle.toString(16)}: ${errMsg(e)}`,
              );
            }
          } else if (cccdHandle === undefined) {
            bleLog.debug(
              `ESPHome: no CCCD descriptor reported for char 0x${handle.toString(16)}; relying on the proxy registration alone`,
            );
          }
          const listener = (raw: unknown): void => {
            if (closed) return;
            const m = raw as EsphomeNotifyData;
            if (m.address !== addr) {
              if (!loggedForeignAddresses.has(m.address)) {
                loggedForeignAddresses.add(m.address);
                bleLog.debug(
                  `ESPHome notify for another device (address ${m.address}), ignored for ${mac}`,
                );
              }
              return;
            }
            if (m.handle === handle) {
              const buf = esphomeGattPayload(m);
              bleLog.debug(
                `ESPHome notify handle 0x${handle.toString(16)} (${buf.length}B): ${buf.toString('hex')}`,
              );
              onData(buf);
            } else {
              // A notify for this device on a handle this listener did not
              // subscribe to. Expected on multi-notify adapters (one listener per
              // characteristic, and every listener sees every event); but for a
              // single-notify adapter it means the discovered characteristic handle
              // and the notify-event handle disagree, so notifications are being
              // silently dropped here (#291).
              const evtHandle =
                typeof m.handle === 'number' ? `0x${m.handle.toString(16)}` : String(m.handle);
              bleLog.debug(
                `ESPHome notify handle mismatch: event ${evtHandle} != subscribed 0x${handle.toString(16)} for this device`,
              );
            }
          };
          return track(NOTIFY_EVENT, listener);
        },
      };
      charMap.set(uuid, char);
    }
  }

  const device: BleDevice = {
    onDisconnect(cb: () => void): void {
      let fired = false;
      track(CONNECTION_EVENT, (raw: unknown) => {
        const m = raw as EsphomeDeviceConnection;
        if (!fired && m.address === addr && m.connected === false) {
          fired = true;
          cb();
        }
      });
    },
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    for (const { event, fn } of registered.splice(0)) {
      conn.removeListener(event, fn);
    }
    try {
      await conn.disconnectBluetoothDeviceService(addr);
    } catch (e) {
      bleLog.debug(`ESPHome GATT disconnect for ${mac} ignored: ${errMsg(e)}`);
    }
  };

  return { charMap, device, close };
}
