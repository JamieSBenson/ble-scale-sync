import { bleLog, errMsg } from '../types.js';
import { isDebugEnabled } from '../../logger.js';
import { helperOf, type Device } from './dbus.js';
import { extractDbusBytes } from './broadcast.js';

/**
 * True when a D-Bus error means the peer's `org.bluez.Device1` object is gone
 * rather than that the connection itself failed.
 *
 * BlueZ scopes the Device object of a peer that is not connectable (or not
 * discoverable) to the lifetime of a discovery session, so `StopDiscovery`
 * followed by `Connect()` can hit an object that no longer exists (#297). Two
 * different producers word that the same situation differently:
 *
 * - dbus-next, when a freshly introspected path carries no such interface:
 *   `interface not found in proxy object: org.bluez.Device1`
 * - bluetoothd, when a cached interface proxy calls a method on a dead object:
 *   `Method "Connect" with signature "" on interface "org.bluez.Device1" doesn't exist`
 *
 * Both branches key on the literal interface name so a GattService1 or
 * GattCharacteristic1 error can never match.
 *
 * A third shape comes from bluetoothd itself when the whole object path is
 * gone: `org.freedesktop.DBus.Error.UnknownObject` naming a `/org/bluez/hciN/
 * dev_XX_..` path. Bleak's BlueZ backend treats exactly that as "removed from
 * BlueZ when scanning stopped", which is independent confirmation of the
 * mechanism, so it is matched on the device path rather than the interface.
 */
export function isDeviceObjectGone(err: unknown): boolean {
  const msg = errMsg(err);
  if (msg.includes('org.bluez.Device1')) {
    return msg.includes('interface not found in proxy object') || msg.includes("doesn't exist");
  }
  // Path-shaped variant: only ever a device node, never an adapter or a GATT
  // child object, so it cannot swallow an unrelated failure.
  return /UnknownObject/i.test(msg) && /\/org\/bluez\/hci\d+\/dev_[0-9A-Fa-f_]+/.test(msg);
}

/**
 * Log the advertised payload of a freshly discovered device at debug level.
 *
 * This is the only window in which BlueZ still holds the advertisement for a
 * peer whose Device object does not survive `StopDiscovery`, and it is what
 * identifies a scale as, say, a Tuya 0xFD50 device that will never accept a
 * GATT connection (#266, #297). Never throws: every property is Optional on
 * org.bluez.Device1.
 */
export async function logAdvertisementSnapshot(device: Device): Promise<void> {
  if (!isDebugEnabled()) return;
  const helper = helperOf(device);
  const read = async (name: string): Promise<unknown> => {
    try {
      return await helper.prop(name);
    } catch {
      return undefined;
    }
  };

  const [addrType, flags, uuids, serviceData, manufacturerData] = await Promise.all([
    read('AddressType'),
    read('AdvertisingFlags'),
    read('UUIDs'),
    read('ServiceData'),
    read('ManufacturerData'),
  ]);

  const parts: string[] = [];
  if (typeof addrType === 'string') parts.push(`addrType=${addrType}`);
  const flagBytes = extractDbusBytes(flags);
  if (flagBytes) parts.push(`flags=${flagBytes.toString('hex')}`);
  if (Array.isArray(uuids) && uuids.length > 0) parts.push(`uuids=[${uuids.join(', ')}]`);
  const dict = (val: unknown, keyFmt: (k: string) => string): string | undefined => {
    if (!val || typeof val !== 'object') return undefined;
    const entries = val instanceof Map ? [...val.entries()] : Object.entries(val);
    const pairs = entries
      .map(([k, v]) => {
        const bytes = extractDbusBytes(v);
        return bytes ? `${keyFmt(String(k))}: ${bytes.toString('hex')}` : undefined;
      })
      .filter((p): p is string => p !== undefined);
    return pairs.length > 0 ? `{${pairs.join(', ')}}` : undefined;
  };
  const sd = dict(serviceData, (k) => k);
  if (sd) parts.push(`serviceData=${sd}`);
  const md = dict(manufacturerData, (k) => `0x${Number(k).toString(16).padStart(4, '0')}`);
  if (md) parts.push(`manufacturerData=${md}`);

  bleLog.debug(
    `Advert: ${parts.length > 0 ? parts.join(' ') : 'no advertised properties exposed'}`,
  );
}
