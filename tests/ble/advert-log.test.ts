import { describe, it, expect, vi, beforeEach } from 'vitest';
import { formatAdvert, logAdvert, _resetAdvertLog } from '../../src/ble/advertisement.js';
import { bleLog } from '../../src/ble/types.js';
import type { BleDeviceInfo } from '../../src/interfaces/scale-adapter.js';

const ADDR = 'AA:BB:CC:DD:EE:FF';

function info(over: Partial<BleDeviceInfo> = {}): BleDeviceInfo {
  return {
    localName: 'Hutbit Scale',
    serviceUuids: ['0000ffb0-0000-1000-8000-00805f9b34fb'],
    ...over,
  };
}

describe('advertisement logging (#322)', () => {
  beforeEach(() => _resetAdvertLog());

  describe('formatAdvert()', () => {
    it('prints the address, the name and 16-bit short UUIDs', () => {
      expect(formatAdvert(ADDR, info())).toBe(
        'Advert: [AA:BB:CC:DD:EE:FF] name="Hutbit Scale" uuids=[ffb0]',
      );
    });

    it('says so explicitly when the advertisement carries no name', () => {
      // The proxy transports see an empty name whenever it lives in the scan
      // response, and "no name" versus "the name did not print" is exactly the
      // distinction a mis-routing report turns on.
      expect(formatAdvert(ADDR, info({ localName: '' }))).toContain('name=(none)');
    });

    it('prints manufacturer data with its company id', () => {
      const line = formatAdvert(
        ADDR,
        info({ manufacturerData: { id: 0x02ac, data: Buffer.from('d618aabbccddeeff', 'hex') } }),
      );
      expect(line).toContain('manufacturerData={0x02ac: d618aabbccddeeff}');
    });

    it('prints service data keyed by its short UUID', () => {
      const line = formatAdvert(
        ADDR,
        info({
          serviceData: [
            { uuid: '0000181d-0000-1000-8000-00805f9b34fb', data: Buffer.from('01', 'hex') },
          ],
        }),
      );
      expect(line).toContain('serviceData={181d: 01}');
    });

    it('prints post-discovery characteristics when they are known', () => {
      const line = formatAdvert(
        ADDR,
        info({ characteristicUuids: ['0000ffb2-0000-1000-8000-00805f9b34fb'] }),
      );
      expect(line).toContain('chars=[ffb2]');
    });

    it('keeps a non-SIG UUID in full rather than truncating it to nonsense', () => {
      const vendor = '0000fee7-0000-1000-8000-00805f9b34fc'; // note the trailing c
      expect(formatAdvert(ADDR, info({ serviceUuids: [vendor] }))).toContain(
        '0000fee700001000800000805f9b34fc',
      );
    });

    it('caps a long UUID list instead of printing a 40-entry line', () => {
      const many = Array.from(
        { length: 14 },
        (_, i) => `0000ff${i.toString(16).padStart(2, '0')}-0000-1000-8000-00805f9b34fb`,
      );
      const line = formatAdvert(ADDR, info({ serviceUuids: many }));
      expect(line).toContain('+4 more');
      expect(line).not.toContain('ff0a,');
    });

    it('caps a long data blob and reports its real length', () => {
      const line = formatAdvert(
        ADDR,
        info({ manufacturerData: { id: 1, data: Buffer.alloc(40, 0xab) } }),
      );
      expect(line).toContain('… (40B)');
    });

    it('does not throw on an advertisement with nothing in it', () => {
      expect(formatAdvert(ADDR, { localName: '', serviceUuids: [] })).toBe(
        'Advert: [AA:BB:CC:DD:EE:FF] name=(none) uuids=[]',
      );
    });
  });

  describe('logAdvert()', () => {
    it('logs the same advertisement once however often the scan re-reads it', () => {
      const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
      logAdvert(ADDR, info());
      logAdvert(ADDR, info());
      logAdvert(ADDR, info());
      expect(debug).toHaveBeenCalledTimes(1);
      debug.mockRestore();
    });

    it('logs again when the content changes, which is the interesting case', () => {
      // A scan response filling in the name, or GATT discovery adding
      // characteristics, changes the inputs the adapter match is made from.
      const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
      logAdvert(ADDR, info({ localName: '' }));
      logAdvert(ADDR, info());
      logAdvert(ADDR, info({ characteristicUuids: ['0000ffb2-0000-1000-8000-00805f9b34fb'] }));
      expect(debug).toHaveBeenCalledTimes(3);
      debug.mockRestore();
    });

    it('tracks each address separately', () => {
      const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
      logAdvert(ADDR, info());
      logAdvert('11:22:33:44:55:66', info());
      expect(debug).toHaveBeenCalledTimes(2);
      debug.mockRestore();
    });
  });
});
