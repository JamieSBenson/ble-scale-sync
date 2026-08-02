import { describe, it, expect } from 'vitest';
import {
  isAuthClassConnectFailure,
  staleBondMessage,
  STALE_BOND_EVIDENCE_ATTEMPTS,
} from '../../../src/ble/handler-node-ble/stale-bond.js';

describe('isAuthClassConnectFailure (#290)', () => {
  it.each([
    'le-connection-abort-by-local',
    'Connect error: le-connection-abort-by-local',
    'Authentication Failed',
    'org.bluez.Error.AuthenticationFailed',
  ])('recognises %s', (msg) => {
    expect(isAuthClassConnectFailure(new Error(msg))).toBe(true);
  });

  it.each([
    'Connection timed out',
    'Device not found',
    'GATT server acquisition timed out',
    'interface not found in proxy object',
    'br-connection-page-timeout',
  ])('does not recognise %s', (msg) => {
    expect(isAuthClassConnectFailure(new Error(msg))).toBe(false);
  });
});

describe('staleBondMessage', () => {
  const msg = staleBondMessage('5C:CA:D3:88:D0:EC', 6, 'le-connection-abort-by-local');

  it('names the peer, the cause and the remedy', () => {
    expect(msg).toContain('5C:CA:D3:88:D0:EC');
    expect(msg).toContain('rejected the stored pairing key');
    expect(msg).toContain('bluetoothctl');
    expect(msg).toContain('remove 5C:CA:D3:88:D0:EC');
    expect(msg).toContain('pair 5C:CA:D3:88:D0:EC');
  });

  it('keeps the underlying BlueZ error for anyone diffing older logs', () => {
    expect(msg).toContain('le-connection-abort-by-local');
  });
});

describe('evidence threshold', () => {
  it('requires a run of failures, not a single one', () => {
    // A single abort has documented benign producers (a connect issued while
    // discovery is still active, or a second D-Bus client holding a session),
    // so one occurrence must never be treated as a stale bond.
    expect(STALE_BOND_EVIDENCE_ATTEMPTS).toBeGreaterThan(1);
  });
});
