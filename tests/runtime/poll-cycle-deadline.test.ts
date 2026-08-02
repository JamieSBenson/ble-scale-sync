import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * A wedged D-Bus transport used to park a poll cycle forever: dbus-next never
 * rejects an in-flight MessageBus.call() when the socket dies, the heartbeat
 * kept ticking, and the consecutive-failure watchdog was therefore never
 * reached. The cycle now has a hard deadline (#290).
 */

const scanAndReadRaw = vi.fn();
vi.mock('../../src/ble/index.js', () => ({ scanAndReadRaw }));

// The deadline is the subject here, not profile resolution, so keep the context
// minimal and stub the resolver rather than building a full valid config.
vi.mock('../../src/config/resolve.js', () => ({
  resolveUserProfile: () => ({ sex: 'male', age: 40, heightCm: 180, athlete: false }),
}));

const { PollReadingSource } = await import('../../src/runtime/poll-source.js');
const { POLL_CYCLE_TIMEOUT_MS } = await import('../../src/ble/types.js');

type Ctx = ConstructorParameters<typeof PollReadingSource>[0];

function makeCtx(): Ctx {
  return {
    config: {
      users: [{ beurer_pin: undefined, beurer_user_index: undefined }],
      scale: {},
    },
    scaleMac: undefined,
    weightUnit: 'kg',
    bleHandler: 'node-ble',
    mqttProxy: undefined,
    esphomeProxy: undefined,
    bleAdapter: undefined,
  } as unknown as Ctx;
}

function makeSource() {
  return new PollReadingSource(makeCtx(), []);
}

describe('poll cycle deadline (#290)', () => {
  beforeEach(() => {
    scanAndReadRaw.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('abandons a cycle that never settles', async () => {
    scanAndReadRaw.mockReturnValue(new Promise(() => {}));
    const source = makeSource();

    const pending = source.nextReading(new AbortController().signal);
    const assertion = expect(pending).rejects.toThrow(/abandoned/);

    await vi.advanceTimersByTimeAsync(POLL_CYCLE_TIMEOUT_MS + 1);
    await assertion;
  });

  it('does not fire before the deadline', async () => {
    scanAndReadRaw.mockReturnValue(new Promise(() => {}));
    const source = makeSource();

    const pending = source.nextReading(new AbortController().signal);
    let settled = false;
    void pending.then(
      () => (settled = true),
      () => (settled = true),
    );

    await vi.advanceTimersByTimeAsync(POLL_CYCLE_TIMEOUT_MS - 1000);
    expect(settled).toBe(false);

    // Let the pending rejection be handled so it does not surface as unhandled.
    const assertion = expect(pending).rejects.toThrow(/abandoned/);
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
  });

  it('passes a normal reading straight through', async () => {
    const reading = { weight: 82.4, impedance: 500 };
    scanAndReadRaw.mockResolvedValue(reading);
    const source = makeSource();

    await expect(source.nextReading(new AbortController().signal)).resolves.toBe(reading);
  });
});
