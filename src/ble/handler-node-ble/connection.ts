import NodeBle from 'node-ble';
import type { MessageBus } from 'dbus-next';
import { bleLog, errMsg } from '../types.js';
import type { Adapter } from './dbus.js';
import { forgetPairingAgent } from './agent.js';

/**
 * Persistent D-Bus connection + adapter, reused across scan cycles in
 * continuous mode. Same client owns the discovery session across cycles;
 * same adapter proxy means stopDiscovery() always matches startDiscovery().
 * Minimizes the start/stop cycling that triggers the BlueZ Discovering desync
 * (bluez/bluez#807, bluez/bluer#47).
 */
let persistentConn: { bluetooth: NodeBle.Bluetooth; destroy: () => void } | null = null;
let persistentAdapter: Adapter | null = null;

/** Latched when the D-Bus transport errors. Cleared by resetConnection(). */
let busFailed = false;

/**
 * Attach a permanent `error` listener to a node-ble session's MessageBus.
 *
 * dbus-next forwards raw socket errors from `connection.js` to `bus.js`, and
 * MessageBus is an EventEmitter, so with no listener Node turns the first one
 * into an uncaught exception and the process dies. A reporter running the
 * container against an unreachable D-Bus socket hit exactly that: `write EPIPE`
 * thrown from `dbus-next/lib/bus.js`, exit code 1, restart loop (#290).
 *
 * Recovery deliberately does not run inside the handler: MessageBus.disconnect()
 * ends the underlying stream, and doing that synchronously from a stream error
 * handler risks reentrant emits. Callers latch and rebuild at a safe point.
 */
export function attachBusErrorHandler(
  bluetooth: NodeBle.Bluetooth,
  onError: (err: unknown) => void,
): void {
  try {
    const bus = (bluetooth as unknown as { dbus: MessageBus }).dbus;
    bus.on('error', onError);
  } catch (err) {
    bleLog.debug(`Could not attach D-Bus error handler: ${errMsg(err)}`);
  }
}

export function getConnection(): { bluetooth: NodeBle.Bluetooth; destroy: () => void } {
  if (!persistentConn) {
    persistentConn = NodeBle.createBluetooth();
    attachBusErrorHandler(persistentConn.bluetooth, (err) => {
      busFailed = true;
      bleLog.warn(
        `D-Bus transport error: ${errMsg(err)}. The connection will be rebuilt before the next scan.`,
      );
    });
    bleLog.debug('D-Bus connection established');
  }
  return persistentConn;
}

/**
 * Underlying dbus-next bus of the persistent connection. node-ble does not type
 * the `dbus` field on Bluetooth, so cast the minimal surface we use (same
 * "declare only what we use" convention as helperOf). Used to register the BlueZ
 * pairing agent (#168).
 */
export function getBus(): MessageBus {
  return (getConnection().bluetooth as unknown as { dbus: MessageBus }).dbus;
}

export async function getAdapter(bleAdapter?: string): Promise<Adapter> {
  if (busFailed) {
    bleLog.warn('Rebuilding the D-Bus connection after a transport error');
    resetConnection();
  }
  const conn = getConnection();
  if (!persistentAdapter) {
    if (bleAdapter) {
      bleLog.debug(`Using adapter: ${bleAdapter}`);
      persistentAdapter = await conn.bluetooth.getAdapter(bleAdapter);
    } else {
      persistentAdapter = await conn.bluetooth.defaultAdapter();
    }
  }
  return persistentAdapter;
}

export function resetConnection(): void {
  busFailed = false;
  persistentAdapter = null;
  if (persistentConn) {
    // Destroying the connection makes BlueZ drop our pairing agent (owner gone),
    // so just forget the local registration; the next connection re-registers.
    forgetPairingAgent();
    try {
      persistentConn.destroy();
    } catch {
      /* ignore */
    }
    persistentConn = null;
    bleLog.debug('D-Bus connection reset');
  }
}

/** Returns true if the error indicates a stale or broken D-Bus connection. */
export function isStaleConnectionError(err: unknown): boolean {
  const msg = errMsg(err);
  return (
    msg.includes('interface not found') ||
    msg.includes('not found in proxy') ||
    msg.includes('connection closed') ||
    msg.includes('The name is not activatable') ||
    msg.includes('was not provided') ||
    // dbus-next transport failures. A caught variant routes into the existing
    // reset-and-retry rather than surfacing as an opaque scan failure (#290).
    msg.includes('stream is closed') ||
    msg.includes('closed stream') ||
    msg.includes('EPIPE')
  );
}

export function isDbusConnectionError(err: unknown): boolean {
  const msg = errMsg(err);
  return msg.includes('ENOENT') && msg.includes('bus_socket');
}

export function dbusError(): Error {
  return new Error(
    'Cannot connect to D-Bus. Bluetooth is not accessible.\n' +
      'If running in Docker, mount the D-Bus socket:\n' +
      '  -v /var/run/dbus:/var/run/dbus:ro\n' +
      'On the host, ensure bluetoothd is running:\n' +
      '  sudo systemctl start bluetooth',
  );
}

/** Extract the numeric index from an hci adapter name (e.g., 'hci1' -> 1). */
export function parseHciIndex(adapterName?: string): number {
  if (!adapterName) return 0;
  const match = adapterName.match(/^hci(\d+)$/);
  return match ? Number(match[1]) : 0;
}
