import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { openGattSession } from '../../../src/ble/handler-esphome-proxy/gatt.js';
import { esphomeGattPayload } from '../../../src/ble/handler-esphome-proxy/esphome-gatt-proto.js';
import { normalizeUuid } from '../../../src/ble/types.js';

const nodeRequire = createRequire(import.meta.url);

/**
 * Regression guard for #291.
 *
 * Every GATT notification and read over the ESPHome proxy decoded to zero bytes
 * from v1.14.0 to v1.21.1, because the bridge read `dataList` while the library
 * emits a base64 string named `data`. The old unit tests hand-rolled the
 * `dataList` shape, so they passed against the broken code.
 *
 * This suite therefore builds its fixtures from the REAL library: protobuf
 * messages round-tripped through serializeBinary and pushed through the same
 * mapMessageByType() call the connection makes. A library upgrade that changes
 * the emitted shape fails here instead of silently zeroing every frame again.
 */
const { pb } = nodeRequire('@2colors/esphome-native-api/lib/utils/messages.js');
const { mapMessageByType } = nodeRequire(
  '@2colors/esphome-native-api/lib/utils/mapMessageByType.js',
);

// macToInt('00:00:00:00:00:01') === 1
const ADDR = 1;

/** Reproduces connection.js: mapMessageByType(type, message.toObject()). */
function libraryShape(msg: {
  constructor: { type: string };
  toObject: () => unknown;
}): Record<string, unknown> {
  return mapMessageByType(msg.constructor.type, msg.toObject()) as Record<string, unknown>;
}

function notifyShape(handle: number, hex: string): Record<string, unknown> {
  const msg = new pb.BluetoothGATTNotifyDataResponse();
  msg.setAddress(ADDR);
  msg.setHandle(handle);
  msg.setData(Uint8Array.from(Buffer.from(hex, 'hex')));
  // Round-trip so the bytes field is stored exactly as a received frame stores it.
  const wire = pb.BluetoothGATTNotifyDataResponse.deserializeBinary(msg.serializeBinary());
  return libraryShape(wire);
}

function readShape(hex: string): Record<string, unknown> {
  const msg = new pb.BluetoothGATTReadResponse();
  msg.setAddress(ADDR);
  msg.setHandle(7);
  msg.setData(Uint8Array.from(Buffer.from(hex, 'hex')));
  const wire = pb.BluetoothGATTReadResponse.deserializeBinary(msg.serializeBinary());
  return libraryShape(wire);
}

function fakeConnection(readHex = '010203') {
  const listeners: Record<string, Array<(a: unknown) => void>> = {};
  return {
    connected: true,
    on(ev: string, fn: (a: unknown) => void) {
      (listeners[ev] ??= []).push(fn);
    },
    off(ev: string, fn: (a: unknown) => void) {
      listeners[ev] = (listeners[ev] ?? []).filter((f) => f !== fn);
    },
    removeListener(ev: string, fn: (a: unknown) => void) {
      this.off(ev, fn);
    },
    emit(ev: string, a: unknown) {
      (listeners[ev] ?? []).forEach((f) => f(a));
    },
    connectBluetoothDeviceService: vi.fn(async () => ({ address: ADDR, connected: true, mtu: 23 })),
    disconnectBluetoothDeviceService: vi.fn(async () => ({ address: ADDR, connected: false })),
    listBluetoothGATTServicesService: vi.fn(async () => ({
      address: ADDR,
      servicesList: [
        {
          uuid: '0000ffb0-0000-1000-8000-00805f9b34fb',
          handle: 1,
          characteristicsList: [
            {
              uuid: '0000ffb2-0000-1000-8000-00805f9b34fb',
              handle: 7,
              properties: 0x10,
              descriptorsList: [{ uuid: '00002902-0000-1000-8000-00805f9b34fb', handle: 8 }],
            },
          ],
        },
      ],
    })),
    readBluetoothGATTCharacteristicService: vi.fn(async () => readShape(readHex)),
    writeBluetoothGATTCharacteristicService: vi.fn(async () => ({})),
    notifyBluetoothGATTCharacteristicService: vi.fn(async () => ({})),
    writeBluetoothGATTDescriptorService: vi.fn(async () => ({})),
  };
}

describe('ESPHome GATT payload decoding (#291)', () => {
  it('library internals still render GATT payloads as a base64 `data` field', () => {
    const shape = notifyShape(24, 'ac0203');
    expect(typeof shape.data).toBe('string');
    expect(shape.data).toBe('rAID');
    // The field the bridge used to read does not exist in this library version.
    expect(shape.dataList).toBeUndefined();
    expect(readShape('010203').data).toBe('AQID');
  });

  it('decodes a real 8-byte Hutbit weight frame end to end', async () => {
    const conn = fakeConnection();
    const session = await openGattSession({ connection: conn } as never, '00:00:00:00:00:01');
    const char = session.charMap.get(normalizeUuid('ffb2'))!;
    const got: Buffer[] = [];
    await char.subscribe((d) => got.push(d));
    conn.emit('message.BluetoothGATTNotifyDataResponse', notifyShape(7, 'ac0203470000ca14'));
    expect(got).toHaveLength(1);
    expect(got[0].toString('hex')).toBe('ac0203470000ca14');
    await session.close();
  });

  it('decodes a fragmented 1-byte notification', async () => {
    const conn = fakeConnection();
    const session = await openGattSession({ connection: conn } as never, '00:00:00:00:00:01');
    const char = session.charMap.get(normalizeUuid('ffb2'))!;
    const got: Buffer[] = [];
    await char.subscribe((d) => got.push(d));
    conn.emit('message.BluetoothGATTNotifyDataResponse', notifyShape(7, 'ac'));
    expect(got[0]).toEqual(Buffer.from([0xac]));
    await session.close();
  });

  it('decodes a characteristic read', async () => {
    const conn = fakeConnection('55aa03');
    const session = await openGattSession({ connection: conn } as never, '00:00:00:00:00:01');
    const char = session.charMap.get(normalizeUuid('ffb2'))!;
    expect((await char.read()).toString('hex')).toBe('55aa03');
    await session.close();
  });

  it('yields an empty buffer for a genuinely empty payload', async () => {
    const conn = fakeConnection();
    const session = await openGattSession({ connection: conn } as never, '00:00:00:00:00:01');
    const char = session.charMap.get(normalizeUuid('ffb2'))!;
    const got: Buffer[] = [];
    await char.subscribe((d) => got.push(d));
    conn.emit('message.BluetoothGATTNotifyDataResponse', notifyShape(7, ''));
    expect(got[0]).toEqual(Buffer.alloc(0));
    await session.close();
  });
});

describe('esphomeGattPayload()', () => {
  it('prefers a legacy dataList over an empty `data` sentinel', () => {
    // mapRawAdvertisement builds entries as { data: '', legacyDataList: [...] },
    // so an empty `data` must not shadow a populated list.
    expect(esphomeGattPayload({ data: '', dataList: [0xac, 0x02] })).toEqual(
      Buffer.from([0xac, 0x02]),
    );
  });

  it('accepts a Uint8Array payload', () => {
    expect(esphomeGattPayload({ data: Uint8Array.from([1, 2]) })).toEqual(Buffer.from([1, 2]));
  });

  it('returns an empty buffer when no payload field is present', () => {
    expect(esphomeGattPayload({})).toEqual(Buffer.alloc(0));
  });
});
