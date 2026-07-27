import { normalizeUuid } from '../types.js';

/**
 * ESPHome encodes a GATT UUID either as a single pre-formatted string or as a
 * [high, low] pair of unsigned 64-bit halves of the 128-bit value
 * (aioesphomeapi convention). Normalize both into the project's 32-char
 * lowercase form so it compares against adapter UUIDs via the existing
 * normalizeUuid().
 *
 * The [high, low] ordering is the documented aioesphomeapi layout; if a real
 * ESP ever hands the halves reversed, swap the two reads here (this is the
 * single point of change called out as risk #2 in the design spec).
 */
export function esphomeUuidToString(uuidList?: Array<string | number | bigint>): string {
  // Defensive: @2colors/esphome-native-api pre-decodes GATT uuids into a `uuid`
  // string and drops `uuidList`, so this fallback path may be handed nothing. A
  // missing/empty list must never throw and kill the whole GATT session (#229).
  if (!uuidList || uuidList.length === 0) return '';
  if (uuidList.length === 1) {
    const only = uuidList[0];
    if (typeof only === 'string') return normalizeUuid(only);
    const v = BigInt(only);
    // <= 0xffff: 16-bit short form, pad to 4 so normalizeUuid expands it via
    // the Bluetooth base UUID. Larger: a full 128-bit value, pad to 32 (same
    // as the [high, low] path below). toString(16) drops leading zeros, so
    // the width must be restored explicitly or the UUID decodes wrong.
    const hex = v <= 0xffffn ? v.toString(16).padStart(4, '0') : v.toString(16).padStart(32, '0');
    return normalizeUuid(hex);
  }
  const mask = (1n << 64n) - 1n;
  const high = BigInt(uuidList[0]) & mask;
  const low = BigInt(uuidList[1]) & mask;
  const full = (high << 64n) | low;
  return normalizeUuid(full.toString(16).padStart(32, '0'));
}

/**
 * Minimal structural types for the connection GATT messages we consume.
 *
 * `@2colors/esphome-native-api` runs every message through `mapMessageByType()`,
 * which for the GATT services response replaces the raw `uuidList` uint64 pair
 * with a pre-decoded `uuid` string. We prefer `uuid` and keep `uuidList` as a
 * fallback in case a different library version delivers the raw shape.
 */
export interface EsphomeGattDescriptor {
  uuid?: string;
  uuidList?: Array<string | number | bigint>;
  shortUuid?: number;
  handle: number;
}

export interface EsphomeGattCharacteristic {
  uuid?: string;
  uuidList?: Array<string | number | bigint>;
  handle: number;
  /** Optional so an unexpected library shape cannot break the whole session. */
  properties?: number;
  descriptorsList?: EsphomeGattDescriptor[];
}

export interface EsphomeGattService {
  uuid?: string;
  uuidList?: Array<string | number | bigint>;
  handle: number;
  characteristicsList: EsphomeGattCharacteristic[];
}

export interface EsphomeGattServicesResponse {
  address: number;
  servicesList: EsphomeGattService[];
}

export interface EsphomeNotifyData {
  address: number;
  handle: number;
  /** protobuf-JS `toObject()` renders the `bytes data = 3` field as a base64
   * string named `data`; some historical library shapes used a `dataList`
   * number array instead. Both are optional so either shape type-checks. */
  data?: string | Uint8Array;
  dataList?: number[];
}

/**
 * Decode the payload of an ESPHome GATT read/notify response.
 *
 * @2colors/esphome-native-api emits `message.toObject()` for GATT responses
 * unmapped, and protobuf-JS renders a `bytes` field as a base64 string named
 * `data`, and never as `dataList` (#291). Accept every shape the library could
 * produce: base64 string, Uint8Array/Buffer, or a legacy `dataList` array.
 *
 * The empty-string guard matters: `data: ''` is a "field not used" sentinel in
 * this library, not an empty payload. mapRawAdvertisement builds entries as
 * `{ uuid, legacyDataList: [...], data: '' }`, so a `dataList` shape must still
 * win over an empty `data` (the same precedence advert.ts already applies).
 */
export function esphomeGattPayload(m: { data?: string | Uint8Array; dataList?: number[] }): Buffer {
  if (typeof m.data === 'string' && m.data.length > 0) return Buffer.from(m.data, 'base64');
  if (m.data instanceof Uint8Array) return Buffer.from(m.data);
  if (Array.isArray(m.dataList)) return Buffer.from(m.dataList);
  return Buffer.alloc(0);
}

/** Client Characteristic Configuration descriptor (CCCD). */
export const CCCD_UUID = normalizeUuid('2902');
/** CCCD value that enables notifications. */
export const CCCD_NOTIFY = Uint8Array.from([0x01, 0x00]);
/** CCCD value that enables indications. */
export const CCCD_INDICATE = Uint8Array.from([0x02, 0x00]);

const CHAR_PROP_NOTIFY = 0x10;
const CHAR_PROP_INDICATE = 0x20;

/**
 * Find the handle of a characteristic's 0x2902 descriptor.
 *
 * ESPHome's bluetooth_proxy implements `bluetooth_gatt_notify` as
 * `esp_ble_gattc_register_for_notify()`, which only tells the ESP32 to route
 * notifications it receives. ESP-IDF leaves writing the CCC descriptor to the
 * client, so without this handle the peripheral is never actually told to send
 * anything (#252).
 */
export function findCccdHandle(ch: EsphomeGattCharacteristic): number | undefined {
  for (const d of ch.descriptorsList ?? []) {
    let uuid = d.uuid ? normalizeUuid(d.uuid) : esphomeUuidToString(d.uuidList);
    if (!uuid && typeof d.shortUuid === 'number') uuid = esphomeUuidToString([d.shortUuid]);
    if (uuid === CCCD_UUID) return d.handle;
  }
  return undefined;
}

/**
 * CCCD payload for a characteristic's property bits, or undefined when it
 * supports neither notify nor indicate. Notify wins when both bits are set,
 * matching Home Assistant's own ESPHome BLE client.
 */
export function cccdValueFor(properties?: number): Uint8Array | undefined {
  // Unknown library shape: notify is the safe default, it is what every
  // notify-capable scale in the registry expects.
  if (typeof properties !== 'number') return CCCD_NOTIFY;
  if (properties & CHAR_PROP_NOTIFY) return CCCD_NOTIFY;
  if (properties & CHAR_PROP_INDICATE) return CCCD_INDICATE;
  return undefined;
}

export interface EsphomeDeviceConnection {
  address: number;
  connected: boolean;
  mtu?: number;
  error?: number;
}
