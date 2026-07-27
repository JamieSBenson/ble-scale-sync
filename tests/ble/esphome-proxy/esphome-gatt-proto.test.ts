import { describe, it, expect } from 'vitest';
import {
  CCCD_INDICATE,
  CCCD_NOTIFY,
  cccdValueFor,
  esphomeUuidToString,
  findCccdHandle,
} from '../../../src/ble/handler-esphome-proxy/esphome-gatt-proto.js';
import { normalizeUuid } from '../../../src/ble/types.js';

describe('esphomeUuidToString', () => {
  it('converts a [high, low] uint64 pair to the normalized 128-bit form', () => {
    // 0x2A9D Weight Measurement -> 00002a9d-0000-1000-8000-00805f9b34fb
    const high = 0x00002a9d00001000n;
    const low = 0x800000805f9b34fbn;
    expect(esphomeUuidToString([high.toString(), low.toString()])).toBe(normalizeUuid('2a9d'));
  });

  it('passes an already-stringified uuid through normalizeUuid', () => {
    expect(esphomeUuidToString(['0000181d-0000-1000-8000-00805f9b34fb'])).toBe(
      normalizeUuid('181d'),
    );
  });

  it('accepts bigint high/low halves (jspb int64 precision-safe path)', () => {
    expect(esphomeUuidToString([0x00002a9d00001000n, 0x800000805f9b34fbn])).toBe(
      normalizeUuid('2a9d'),
    );
  });

  it('hex-decodes a single numeric 16-bit UUID (not decimal stringify)', () => {
    // 0x181d -> must be the Weight Scale service, not normalizeUuid("6157")
    expect(esphomeUuidToString([0x181d])).toBe(normalizeUuid('181d'));
  });

  it('hex-decodes a single bigint 128-bit UUID', () => {
    const full = 0x00002a9d00001000800000805f9b34fbn;
    expect(esphomeUuidToString([full])).toBe(normalizeUuid('2a9d'));
  });

  it('returns empty string for a missing/empty uuidList (no throw)', () => {
    expect(esphomeUuidToString(undefined)).toBe('');
    expect(esphomeUuidToString([])).toBe('');
  });
});

describe('findCccdHandle (#252)', () => {
  it('returns the handle of a pre-decoded 0x2902 descriptor', () => {
    expect(
      findCccdHandle({
        handle: 7,
        descriptorsList: [{ uuid: '00002902-0000-1000-8000-00805f9b34fb', handle: 8 }],
      }),
    ).toBe(8);
  });

  it('resolves a raw [high, low] uuidList descriptor pair', () => {
    expect(
      findCccdHandle({
        handle: 7,
        descriptorsList: [{ uuidList: [0x0000290200001000n, 0x800000805f9b34fbn], handle: 8 }],
      }),
    ).toBe(8);
  });

  it('falls back to shortUuid when uuid and uuidList are absent', () => {
    expect(findCccdHandle({ handle: 7, descriptorsList: [{ shortUuid: 0x2902, handle: 8 }] })).toBe(
      8,
    );
  });

  it('skips a non-CCCD descriptor such as 0x2901', () => {
    expect(
      findCccdHandle({
        handle: 7,
        descriptorsList: [{ uuid: '00002901-0000-1000-8000-00805f9b34fb', handle: 8 }],
      }),
    ).toBeUndefined();
  });

  it('returns undefined for a missing or empty descriptorsList (no throw)', () => {
    expect(findCccdHandle({ handle: 7 })).toBeUndefined();
    expect(findCccdHandle({ handle: 7, descriptorsList: [] })).toBeUndefined();
  });
});

describe('cccdValueFor (#252)', () => {
  it('prefers notify when both notify and indicate bits are set', () => {
    expect(cccdValueFor(0x30)).toEqual(CCCD_NOTIFY);
  });

  it('returns the indicate payload for an indicate-only characteristic', () => {
    expect(cccdValueFor(0x20)).toEqual(CCCD_INDICATE);
  });

  it('returns undefined when neither bit is set', () => {
    expect(cccdValueFor(0x02)).toBeUndefined();
  });

  it('defaults to notify when the library reports no properties', () => {
    expect(cccdValueFor(undefined)).toEqual(CCCD_NOTIFY);
  });
});
