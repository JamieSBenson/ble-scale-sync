import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// Suppress log output during tests.
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

vi.mock('dbus-next', () => ({
  Variant: class {
    constructor(
      public signature: string,
      public value: unknown,
    ) {}
  },
  interface: {
    Interface: class {
      constructor(_name?: string) {}
      static configureMembers(): void {}
    },
    ACCESS_READWRITE: 'readwrite',
  },
  DBusError: class extends Error {},
}));

vi.mock('node-ble', () => ({
  default: { createBluetooth: vi.fn() },
}));

const { isDeviceObjectGone, logAdvertisementSnapshot } =
  await import('../../src/ble/handler-node-ble/device-object.js');
const { _internals } = await import('../../src/ble/handler-node-ble/index.js');
const { setLogLevel, LogLevel } = await import('../../src/logger.js');

/** Exact text bluetoothd returned in the #297 log, trailing newline included. */
const BLUETOOTHD_UNKNOWN_METHOD =
  'Method "Connect" with signature "" on interface "org.bluez.Device1" doesn\'t exist\n';
const DBUS_NEXT_MISSING_IFACE = 'interface not found in proxy object: org.bluez.Device1';

describe('isDeviceObjectGone() (#297)', () => {
  it('matches the dbus-next missing-interface shape', () => {
    expect(isDeviceObjectGone(new Error(DBUS_NEXT_MISSING_IFACE))).toBe(true);
  });

  it('matches the bluetoothd UnknownMethod shape including the trailing newline', () => {
    expect(isDeviceObjectGone(new Error(BLUETOOTHD_UNKNOWN_METHOD))).toBe(true);
  });

  it('does not match a GATT interface proxy error', () => {
    expect(
      isDeviceObjectGone(new Error('interface not found in proxy object: org.bluez.GattService1')),
    ).toBe(false);
  });

  it('does not match an ordinary connect failure', () => {
    expect(isDeviceObjectGone(new Error('le-connection-abort-by-local'))).toBe(false);
    expect(isDeviceObjectGone(new Error('Connection timed out'))).toBe(false);
  });
});

interface MockHelper extends EventEmitter {
  prop: ReturnType<typeof vi.fn>;
  callMethod: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  object: string;
}

function makeHelper(props: Record<string, unknown> = {}): MockHelper {
  const ee = new EventEmitter() as MockHelper;
  ee.prop = vi.fn(async (name: string) => {
    if (name in props) {
      const v = props[name];
      if (v instanceof Error) throw v;
      return v;
    }
    if (name === 'RSSI') return -55;
    return undefined;
  });
  ee.callMethod = vi.fn(async () => undefined);
  ee.set = vi.fn(async () => undefined);
  ee.object = '/org/bluez/hci0';
  return ee;
}

interface MockDevice {
  helper: MockHelper;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  isPaired?: ReturnType<typeof vi.fn>;
}

function makeDevice(connectImpl: () => Promise<void>): MockDevice {
  return {
    helper: makeHelper(),
    connect: vi.fn(connectImpl),
    disconnect: vi.fn(async () => undefined),
    isPaired: vi.fn(async () => false),
  };
}

function makeAdapter(reDiscovered: MockDevice) {
  return {
    helper: makeHelper(),
    isDiscovering: vi.fn(async () => false),
    startDiscovery: vi.fn(async () => undefined),
    stopDiscovery: vi.fn(async () => undefined),
    waitDevice: vi.fn(async () => reDiscovered),
    getDevice: vi.fn(async () => reDiscovered),
  };
}

describe('connectWithRecovery: vanishing org.bluez.Device1 (#297)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('arms the discovery-active strategy and connects on the retry', async () => {
    const initial = makeDevice(async () => {
      throw new Error(BLUETOOTHD_UNKNOWN_METHOD);
    });
    const reDiscovered = makeDevice(async () => undefined);
    const btAdapter = makeAdapter(reDiscovered);

    const result = await _internals.connectWithRecovery({
      btAdapter: btAdapter as never,
      mac: 'A0:85:61:91:E9:4F',
      initialDevice: initial as never,
      maxRetries: 1,
    });

    expect(result).toBe(reDiscovered);
    expect(btAdapter.startDiscovery).toHaveBeenCalled();
    expect(reDiscovered.connect).toHaveBeenCalledTimes(1);
  });

  it('does not stop discovery between retries once armed', async () => {
    const initial = makeDevice(async () => {
      throw new Error(DBUS_NEXT_MISSING_IFACE);
    });
    const reDiscovered = makeDevice(async () => undefined);
    const btAdapter = makeAdapter(reDiscovered);

    await _internals.connectWithRecovery({
      btAdapter: btAdapter as never,
      mac: 'A0:85:61:91:E9:4F',
      initialDevice: initial as never,
      maxRetries: 1,
    });

    // Only the post-connect stop that restores the no-discovery-during-GATT
    // invariant; never the between-retries stop that kills the device object.
    expect(btAdapter.stopDiscovery).toHaveBeenCalledTimes(1);
    const stopOrder = btAdapter.stopDiscovery.mock.invocationCallOrder[0] ?? 0;
    const connectOrder = reDiscovered.connect.mock.invocationCallOrder[0] ?? 0;
    expect(connectOrder).toBeLessThan(stopOrder);
  });

  it('still stops discovery between retries for an ordinary connect failure', async () => {
    const initial = makeDevice(async () => {
      throw new Error('le-connection-abort-by-local');
    });
    const reDiscovered = makeDevice(async () => undefined);
    const btAdapter = makeAdapter(reDiscovered);

    await _internals.connectWithRecovery({
      btAdapter: btAdapter as never,
      mac: 'AA:BB:CC:DD:EE:FF',
      initialDevice: initial as never,
      maxRetries: 1,
    });

    expect(btAdapter.stopDiscovery).toHaveBeenCalledTimes(1);
    const stopOrder = btAdapter.stopDiscovery.mock.invocationCallOrder[0] ?? 0;
    const connectOrder = reDiscovered.connect.mock.invocationCallOrder[0] ?? 0;
    expect(stopOrder).toBeLessThan(connectOrder);
  });

  it('explains the vanishing device object when every attempt fails that way', async () => {
    const initial = makeDevice(async () => {
      throw new Error(BLUETOOTHD_UNKNOWN_METHOD);
    });
    const reDiscovered = makeDevice(async () => {
      throw new Error(DBUS_NEXT_MISSING_IFACE);
    });
    const btAdapter = makeAdapter(reDiscovered);

    await expect(
      _internals.connectWithRecovery({
        btAdapter: btAdapter as never,
        mac: 'A0:85:61:91:E9:4F',
        initialDevice: initial as never,
        maxRetries: 1,
      }),
    ).rejects.toThrow(/keeps removing the D-Bus object/);
  });

  it('honours keepDiscoveryDuringConnect passed by the caller', async () => {
    const initial = makeDevice(async () => {
      throw new Error('Connection timed out');
    });
    const reDiscovered = makeDevice(async () => undefined);
    const btAdapter = makeAdapter(reDiscovered);

    await _internals.connectWithRecovery({
      btAdapter: btAdapter as never,
      mac: 'A0:85:61:91:E9:4F',
      initialDevice: initial as never,
      maxRetries: 1,
      keepDiscoveryDuringConnect: true,
    });

    // Only the post-connect stop.
    expect(btAdapter.stopDiscovery).toHaveBeenCalledTimes(1);
  });
});

describe('logAdvertisementSnapshot() (#297)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setLogLevel(LogLevel.DEBUG);
  });

  it('logs advertised UUIDs, service data and manufacturer data as hex', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const device = {
      helper: makeHelper({
        AddressType: 'public',
        UUIDs: ['0000fd50-0000-1000-8000-00805f9b34fb'],
        ServiceData: { '0000fd50-0000-1000-8000-00805f9b34fb': Buffer.from([0xac, 0x02]) },
        ManufacturerData: { 2409: Buffer.from([0x01, 0x02]) },
      }),
    };

    await logAdvertisementSnapshot(device as never);

    const line = spy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('Advert:'));
    expect(line).toBeDefined();
    expect(line).toContain('0000fd50-0000-1000-8000-00805f9b34fb');
    expect(line).toContain('ac02');
    expect(line).toContain('0x0969');
    expect(line).toContain('addrType=public');
  });

  it('never rejects when every property is missing', async () => {
    const device = {
      helper: makeHelper({
        AddressType: new Error('No such property'),
        UUIDs: new Error('No such property'),
        ServiceData: new Error('No such property'),
        ManufacturerData: new Error('No such property'),
        AdvertisingFlags: new Error('No such property'),
      }),
    };
    await expect(logAdvertisementSnapshot(device as never)).resolves.toBeUndefined();
  });

  it('reads nothing at all when debug logging is off', async () => {
    setLogLevel(LogLevel.INFO);
    const helper = makeHelper({ UUIDs: ['0000181d-0000-1000-8000-00805f9b34fb'] });
    await logAdvertisementSnapshot({ helper } as never);
    expect(helper.prop).not.toHaveBeenCalled();
    setLogLevel(LogLevel.DEBUG);
  });
});
