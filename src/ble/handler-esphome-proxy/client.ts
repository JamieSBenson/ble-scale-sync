import { createRequire } from 'node:module';
import type { EsphomeProxyConfig } from '../../config/schema.js';
import { bleLog, errMsg } from '../types.js';

const nodeRequire = createRequire(import.meta.url);

// ─── Constants ────────────────────────────────────────────────────────────────

export const CONNECT_TIMEOUT_MS = 30_000;

// ─── Unknown-message patch (#252) ────────────────────────────────────────────

/**
 * Inert stand-in returned for API messages this library version cannot decode.
 * `connection.js` reads `message.constructor.type` and calls `message.toObject()`
 * on every frame, so the placeholder must satisfy both. `mapMessageByType()`
 * passes an unrecognised type straight through, and nothing listens for
 * `message.UnknownEsphomeMessage`, so the frame is effectively ignored.
 */
class UnknownEsphomeMessage {
  static type = 'UnknownEsphomeMessage';
  toObject(): Record<string, never> {
    return {};
  }
}

/** Set before the attempt so a failing patch is not retried on every reconnect. */
let patchAttempted = false;

/**
 * Repair `FrameHelper.buildMessage` in `@2colors/esphome-native-api` (1.3.6).
 *
 * The shipped implementation does `pb[id_to_type[messageId]].deserializeBinary()`,
 * which throws for an id it does not know, and then runs
 * `if (typeof id_to_type[messageId] !== undefined) this.end();`. `typeof` always
 * yields a string, so that guard is always true and the proxy connection is torn
 * down for UNKNOWN ids as well. Newer ESPHome firmware emits id 137
 * (InfraredRFReceiveEvent) on every IR/RF event, so any proxy node with a
 * `remote_receiver` dropped the connection constantly and lost in-flight
 * readings. `buildMessage` also returned undefined, which the frame helpers then
 * dereferenced ("Cannot set properties of undefined (setting 'length')").
 *
 * Clients are expected to ignore unrecognised message types, so we skip them and
 * keep the link up, while preserving the original teardown for a KNOWN type that
 * fails to parse (there the stream really is desynced).
 *
 * Patching the prototype covers both NoiseFrameHelper and PlaintextFrameHelper.
 * `createRequire` resolves the same module instance the dynamically imported
 * Client uses (Node shares the CJS require cache with ESM interop). If a future
 * release moves these internals the feature check and try/catch fall back to the
 * library default, which is the current behaviour, so this cannot regress.
 */
function patchUnknownMessageHandling(): void {
  if (patchAttempted) return;
  patchAttempted = true;
  try {
    const FrameHelper = nodeRequire('@2colors/esphome-native-api/lib/utils/frameHelper.js');
    const { id_to_type, pb } = nodeRequire('@2colors/esphome-native-api/lib/utils/messages.js');
    if (typeof FrameHelper?.prototype?.buildMessage !== 'function') {
      bleLog.warn(
        'ESPHome unknown-message patch skipped: buildMessage not found (library internals changed).',
      );
      return;
    }
    FrameHelper.prototype.buildMessage = function (
      this: { emit: (event: string, err: Error) => void; end: () => void },
      messageId: number,
      bytes: Uint8Array,
    ): unknown {
      const type = id_to_type[messageId];
      if (type === undefined || !pb[type]) {
        // Unknown id (e.g. 137 InfraredRFReceiveEvent): ignore, keep the link up.
        return new UnknownEsphomeMessage();
      }
      try {
        return pb[type].deserializeBinary(bytes);
      } catch {
        this.emit('error', new Error(`Failed to parse ESPHome message ${type} (id ${messageId}).`));
        this.end();
        return undefined;
      }
    };
  } catch (e: unknown) {
    bleLog.warn(`ESPHome unknown-message patch failed, using library default: ${errMsg(e)}`);
  }
}

/** Exposed for the regression test that guards the patched library internals. */
export const _internals = { patchUnknownMessageHandling };

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Shape emitted by `@2colors/esphome-native-api`'s `ble` event. The library
 * merges the legacy structured path and the raw-advertisement path into the
 * same event, so fields overlap: `legacyDataList` (raw path, array of bytes)
 * OR `data` (legacy path, base64 string). We accept both.
 */
export interface EsphomeServiceData {
  uuid: string;
  legacyDataList?: number[];
  data?: string;
}

export interface EsphomeBleAdvertisement {
  address: number; // uint64 MAC packed as JS number (48-bit so safe)
  name: string;
  rssi: number;
  serviceUuidsList?: string[];
  serviceDataList?: EsphomeServiceData[];
  manufacturerDataList?: EsphomeServiceData[];
  addressType?: number;
}

/**
 * Minimal structural view of the `@2colors/esphome-native-api` Client we use.
 * `connection` is the underlying EventEmitter that carries GATT messages
 * (`message.BluetoothGATT*`), used by the Phase 2 GATT bridge.
 */
export interface EsphomeClient {
  connect(): void;
  disconnect(): void;
  // 'reconnect' is emitted by the Connection, never by the Client.
  on(event: 'connected' | 'disconnected' | 'initialized', listener: () => void): EsphomeClient;
  on(event: 'ble', listener: (msg: EsphomeBleAdvertisement) => void): EsphomeClient;
  on(event: 'error', listener: (err: unknown) => void): EsphomeClient;
  removeListener(event: string, listener: (...args: unknown[]) => void): EsphomeClient;
  connected: boolean;
  connection: EsphomeConnection;
}

/** Underlying Connection EventEmitter (carries the GATT protobuf messages). */
export interface EsphomeConnection {
  on(event: string, listener: (msg: unknown) => void): void;
  off(event: string, listener: (msg: unknown) => void): void;
  removeListener(event: string, listener: (msg: unknown) => void): void;
  connectBluetoothDeviceService(address: number, addressType?: number): Promise<unknown>;
  disconnectBluetoothDeviceService(address: number): Promise<unknown>;
  listBluetoothGATTServicesService(address: number): Promise<unknown>;
  readBluetoothGATTCharacteristicService(address: number, handle: number): Promise<unknown>;
  writeBluetoothGATTCharacteristicService(
    address: number,
    handle: number,
    value: Uint8Array,
    response: boolean,
  ): Promise<unknown>;
  notifyBluetoothGATTCharacteristicService(address: number, handle: number): Promise<unknown>;
  /**
   * ESPHome hardcodes response=true (ATT Write Request) for descriptor writes,
   * so there is no `response` parameter here (#252).
   */
  writeBluetoothGATTDescriptorService(
    address: number,
    handle: number,
    value: Uint8Array,
  ): Promise<unknown>;
  /**
   * Optional so existing test doubles with a bare `connection: {}` still
   * type-check. Used by safeDisconnect to guarantee teardown.
   */
  disconnect?(): void;
}

// ─── Client factory ──────────────────────────────────────────────────────────

export async function createEsphomeClient(config: EsphomeProxyConfig): Promise<EsphomeClient> {
  // Must run before the Client (and its FrameHelper) is constructed. #252
  patchUnknownMessageHandling();

  const mod = (await import('@2colors/esphome-native-api')) as unknown as {
    Client: new (options: Record<string, unknown>) => EsphomeClient;
  };

  const options: Record<string, unknown> = {
    host: config.host,
    port: config.port,
    clientInfo: config.client_info,
    // Library stores this flag and re-runs subscribeBluetoothAdvertisementService()
    // on every `authorized` event, so BLE advertisements resume automatically
    // after reconnect without any manual action here.
    initializeSubscribeBLEAdvertisements: true,
    // Keep heavy-weight init steps off; we only need BLE advertisements
    initializeDeviceInfo: false,
    initializeListEntities: false,
    initializeSubscribeStates: false,
    initializeSubscribeLogs: false,
    reconnect: true,
  };
  if (config.encryption_key) options.encryptionKey = config.encryption_key;
  if (config.password) options.password = config.password;

  const client = new mod.Client(options);

  // Keep a permanent 'error' listener for the client's whole lifetime.
  // waitForConnected() attaches its own only for the connect handshake and
  // removes it on success — afterwards the client would have no 'error'
  // listener, so any error the library emits (e.g. an API message a newer
  // ESPHome release added but this library version cannot parse, #210)
  // becomes an uncaught exception that kills the process. Log it instead and
  // let the library's `reconnect: true` handle recovery.
  client.on('error', (err) => {
    bleLog.warn(`ESPHome proxy ${config.host}:${config.port} error: ${errMsg(err)}`);
  });

  // Lifecycle logging (#303). Without it a dead transport and a quiet house are
  // indistinguishable in the log: a reporter lost 4h35m of readings after a
  // single ECONNRESET with no further output of any kind, and could not tell
  // whether the client had reconnected, whether the advertisement subscription
  // had come back, or whether anything had happened at all.
  const ep = `${config.host}:${config.port}`;
  client.on('connected', () => bleLog.info(`ESPHome proxy ${ep} connected`));
  client.on('disconnected', () => bleLog.info(`ESPHome proxy ${ep} disconnected`));
  // Emitted only after subscribeBluetoothAdvertisementService() resolves, so it
  // is the positive confirmation that BLE advertisements are actually flowing.
  client.on('initialized', () =>
    bleLog.info(`ESPHome proxy ${ep} initialized, BLE advertisement subscription active`),
  );
  // 'reconnect' lives on the Connection, not the Client. Optional-chained
  // because test doubles and older library builds may not expose `connection`.
  client.connection?.on?.('reconnect', () =>
    bleLog.info(`ESPHome proxy ${ep} scheduling reconnect (library retries every 30s)`),
  );

  return client;
}

export async function waitForConnected(
  client: EsphomeClient,
  hostPort: string = 'host:port',
): Promise<void> {
  if (client.connected) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      client.removeListener('connected', onConnected as (...args: unknown[]) => void);
      client.removeListener('error', onError as (...args: unknown[]) => void);
    };
    const onConnected = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onError = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err instanceof Error ? err : new Error(errMsg(err)));
    };
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Timed out connecting to ESPHome proxy at ${hostPort}.`));
    }, CONNECT_TIMEOUT_MS);
    client.on('connected', onConnected);
    client.on('error', onError);
    try {
      client.connect();
    } catch (err) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err instanceof Error ? err : new Error(errMsg(err)));
    }
  });
}

export async function safeDisconnect(client: EsphomeClient): Promise<void> {
  try {
    client.disconnect();
  } catch {
    /* ignore */
  } finally {
    // Client.disconnect() calls unsubscribeBluetoothAdvertisementService()
    // first, which throws "Not authorized" in the window where the socket is
    // connected but the hello/auth round trip has not finished. That throw
    // happens BEFORE connection.disconnect(), so the old Connection keeps
    // reconnect:true, keeps its ping and reconnect timers running, and keeps
    // holding the node's single advertisement-subscription slot. Swallowing it
    // silently was enough to leak a client per teardown (#303).
    try {
      client.connection?.disconnect?.();
    } catch {
      /* ignore */
    }
  }
}
