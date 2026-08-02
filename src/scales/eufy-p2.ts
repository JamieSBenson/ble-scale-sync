import { createHash, createCipheriv, createDecipheriv, randomUUID } from 'node:crypto';
import { computeBiaFat, buildPayload, uuid16, xorChecksum } from './body-comp-helpers.js';
import type {
  BleDeviceInfo,
  CharacteristicBinding,
  ConnectionContext,
  ScaleAdapterCore,
  GattWiring,
  MultiCharNotify,
  BroadcastSource,
  ScaleReading,
  UserProfile,
  BodyComposition,
} from '../interfaces/scale-adapter.js';
import { bleLog, normalizeUuid } from '../ble/types.js';
import type { MatchDescriptor } from './match-descriptor.js';

/**
 * Eufy Smart Scale P2 (T9148) and P2 Pro (T9149).
 *
 * Ported from bdr99/eufylife-ble-client (MIT). The P2/P2 Pro use FFF0 service
 * with three characteristics: FFF1 write (commands + auth), FFF2 notify (weight
 * data), FFF4 notify (auth responses). Before the scale streams weight data on
 * FFF2, the client must complete a C0/C1/C2/C3 handshake over FFF1 -> FFF4.
 *
 * Handshake:
 *   key = MD5(MAC without separators, uppercase ASCII)
 *   iv  = "0000000000000000"  (16 ASCII '0' bytes, NOT 16 zero bytes)
 *
 *   1. client -> scale on FFF1:   C0 <segs> <seg_idx> <total_len> <payload> <XOR>
 *      payload = hex of ASCII-base64(AES-128-CBC(random 15-char UUID))
 *      15 chars of base64 per segment; total_len = total bytes of base64 string
 *
 *   2. scale  -> client on FFF4:  C1 <segs> <seg_idx> <total_len> <payload> <XOR>
 *      reassemble, base64-decode, AES-decrypt -> device UUID (arbitrary text)
 *
 *   3. client -> scale on FFF1:   C2 ... = AES-CBC(f"{clientUuid}_{deviceUuid}")
 *
 *   4. scale  -> client on FFF4:  C3 01 00 01 <status> <XOR>
 *      status == 0 means auth successful. From then on FFF2 yields weight frames.
 *
 * Weight frame (FFF2, exactly 16 bytes). Layout verified byte for byte against
 * three real P2 Pro frames with app-reported ground truth (#289):
 *   [0]      0xCF signature
 *   [1]      0x0E payload length, i.e. the bytes after the 2-byte header
 *   [2]      0x00
 *   [3]      0xCF frame type
 *   [4..5]   varies per measurement, NOT impedance (see below)
 *   [6..7]   weight LE / 100 = kg
 *   [8..10]  high entropy, no measurement meaning found
 *   [12]     0x00 when final (stable) reading
 *   [15]     XOR of bytes [2..14]
 *
 * Impedance is not decodable from this frame on the evidence available, and
 * offset [4..5] is actively disfavoured as a candidate. Across the three #289
 * samples (87.90 kg / 30.1 %, 87.50 kg / 29.5 %, 87.65 kg / 29.8 %) it reads
 * 4360, 4210, 4170 LE, which ranks in the wrong order against the reported body
 * fat, varies about five times more than the observed body fat spread allows,
 * and fits worse than assuming impedance is constant. Both the GATT and the
 * broadcast path stay weight-only and let the shared Deurenberg fallback
 * estimate composition.
 *
 * Advertisement frame (19 bytes of vendor data, company ID 0xFF48):
 *   [0..5] scale MAC
 *   [6]    0xCF signature
 *   [7]    heart rate (valid only when (byte[8] >> 6) == 0b11)
 *   [8]    flags
 *   [9..10] weight LE / 100 = kg
 *   [15]   0x00 when final (stable) reading
 *
 * Advertisement mode works without authentication (passive broadcast), so
 * devices that refuse connection still yield weight (no BIA/impedance).
 */

const CHR_WRITE = uuid16(0xfff1);
const CHR_DATA = uuid16(0xfff2);
const CHR_AUTH = uuid16(0xfff4);
const SVC_UUID = uuid16(0xfff0);

const AES_IV = Buffer.from('0000000000000000', 'ascii');
const MIN_WEIGHT_KG = 2;
const MAX_WEIGHT_KG = 200;

/**
 * Hold window (ms) for the weight-stability gate. The scale flags a frame as
 * final (byte[12] == 0) while the weight can still be settling, so resolving on
 * the first final frame occasionally exported a drifting value (#284). Instead
 * we hold the link open after the first final frame and resolve as soon as two
 * consecutive final frames report the same weight (isFinal). If the weight never
 * settles to two equal frames within this window, shared.ts resolves the last
 * held reading, so the gate can never lose a reading it would previously have
 * returned.
 */
const WEIGHT_STABLE_HOLD_MS = 3000;

/** Company ID used in Eufy P2/P2 Pro advertisement manufacturer data. */
const EUFY_COMPANY_ID = 0xff48;

/**
 * Delay between successive sub-contract writes during the C0 and C2 handshake.
 * Matches the bdr99/eufylife-ble-client Python reference (1s `asyncio.sleep`),
 * which is what the EufyLife app effectively uses. Shorter delays (200 ms)
 * were observed to trigger disconnects on some T9149 units.
 */
const EUFY_WRITE_DELAY_MS = 1000;

/** XOR checksum over every byte of a frame (matches Python util.compute_checksum). */
function xor(bytes: Buffer): number {
  return xorChecksum(bytes, 0, bytes.length);
}

/**
 * Split encrypted payload (already hex of ASCII-base64) into sub-contract frames.
 *
 * Each segment carries up to 15 base64 ASCII chars (30 hex chars). Frame layout
 * matches Python `get_sub_contract_bytes`:
 *   <prefix 1B> <num_segments 1B> <seg_idx 1B> <base64_total_bytes 1B> <payload...> <XOR 1B>
 */
export function buildSubContract(dataHex: string, prefix: number): Buffer[] {
  const origLen = dataHex.length;
  const numSegments = Math.ceil(origLen / 30) || 1;
  const base64Bytes = origLen / 2; // dataHex encodes a base64 ASCII string
  const frames: Buffer[] = [];

  for (let i = 0; i < numSegments; i++) {
    const slice = dataHex.slice(i * 30, (i + 1) * 30);
    const header = Buffer.from([prefix, numSegments, i, base64Bytes]);
    const payload = Buffer.from(slice, 'hex');
    const body = Buffer.concat([header, payload]);
    const frame = Buffer.concat([body, Buffer.from([xor(body)])]);
    frames.push(frame);
  }
  return frames;
}

/** Reassemble segmented payload across multiple notifications keyed by prefix. */
class SegmentReassembler {
  private readonly prefix: number;
  private buffer: Buffer = Buffer.alloc(0);
  private expectedSegments = 0;
  private expectedTotalBytes = 0;
  private nextSegment = 0;

  constructor(prefix: number) {
    this.prefix = prefix;
  }

  private reset(): void {
    this.buffer = Buffer.alloc(0);
    this.expectedSegments = 0;
    this.expectedTotalBytes = 0;
    this.nextSegment = 0;
  }

  /** Feed a single notification frame. Returns the full payload once last segment arrives. */
  feed(frame: Buffer): Buffer | null {
    if (frame.length < 5 || frame[0] !== this.prefix) return null;

    // Validate trailing XOR checksum over header + payload.
    const body = frame.subarray(0, frame.length - 1);
    const expectedXor = frame[frame.length - 1];
    if (xor(body) !== expectedXor) {
      bleLog.debug(
        `Eufy: dropping segment with bad XOR (got 0x${expectedXor.toString(16)}, expected 0x${xor(body).toString(16)})`,
      );
      return null;
    }

    const numSegments = frame[1];
    const segIdx = frame[2];
    const totalBytes = frame[3];

    if (segIdx === 0) {
      this.reset();
      this.expectedSegments = numSegments;
      this.expectedTotalBytes = totalBytes;
    }

    if (segIdx !== this.nextSegment) {
      bleLog.debug(`Eufy: out-of-order segment (expected ${this.nextSegment}, got ${segIdx})`);
      return null;
    }

    // Payload is between header (4 bytes) and trailing checksum (1 byte)
    const payload = frame.subarray(4, frame.length - 1);
    this.buffer = Buffer.concat([this.buffer, payload]);
    this.nextSegment += 1;

    if (segIdx === numSegments - 1) {
      const out = this.buffer;
      const expected = this.expectedTotalBytes;
      this.reset();
      if (out.length !== expected) {
        bleLog.debug(
          `Eufy: reassembled payload length ${out.length} differs from advertised ${expected}; dropping frame`,
        );
        return null;
      }
      return out;
    }
    return null;
  }
}

/**
 * Authentication helper. Encapsulates key generation and C0/C1/C2/C3 handling.
 * Exported so tests can verify frame assembly independently.
 */
export class EufyAuthHandler {
  readonly key: Buffer;
  readonly clientUuid: string;
  private readonly c1Reassembler = new SegmentReassembler(0xc1);
  private deviceUuid: string | null = null;
  private authSuccess = false;

  constructor(mac: string, clientUuid?: string) {
    const macClean = mac.replace(/[:-]/g, '').toUpperCase();
    if (!/^[0-9A-F]{12}$/.test(macClean)) {
      throw new Error(`Eufy: invalid MAC "${mac}" (need 6 hex octets)`);
    }
    this.key = createHash('md5').update(macClean, 'utf8').digest();
    this.clientUuid = clientUuid ?? randomUUID().slice(0, 15);
  }

  get deviceUuidOrNull(): string | null {
    return this.deviceUuid;
  }

  get isAuthenticated(): boolean {
    return this.authSuccess;
  }

  /** Encrypt + base64 + hex + sub-contract to C0 frames. */
  buildC0(): Buffer[] {
    return buildSubContract(this.encryptToHex(this.clientUuid), 0xc0);
  }

  /** Feed a C1 notification. Returns true once the full device UUID is assembled. */
  handleC1(frame: Buffer): boolean {
    const payload = this.c1Reassembler.feed(frame);
    if (!payload) return false;
    // Payload is ASCII base64 of encrypted device UUID
    const encrypted = Buffer.from(payload.toString('ascii'), 'base64');
    this.deviceUuid = this.decrypt(encrypted);
    return true;
  }

  /** Encrypt combined `{clientUuid}_{deviceUuid}` + base64 + hex + sub-contract to C2 frames. */
  buildC2(): Buffer[] {
    if (!this.deviceUuid) throw new Error('Eufy: buildC2 called before C1 received');
    const combined = `${this.clientUuid}_${this.deviceUuid}`;
    return buildSubContract(this.encryptToHex(combined), 0xc2);
  }

  /** Feed a C3 notification. Returns true when result byte is present. */
  handleC3(frame: Buffer): boolean {
    if (frame.length < 5 || frame[0] !== 0xc3) return false;
    this.authSuccess = frame[4] === 0;
    return true;
  }

  private encryptToHex(plaintext: string): string {
    const cipher = createCipheriv('aes-128-cbc', this.key, AES_IV);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.from(encrypted.toString('base64'), 'ascii').toString('hex');
  }

  private decrypt(encrypted: Buffer): string {
    const decipher = createDecipheriv('aes-128-cbc', this.key, AES_IV);
    const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return plaintext.toString('utf8');
  }
}

/**
 * Observed FFF2 invariants, reported and never enforced.
 *
 * All three real P2 Pro frames in #289 satisfy both:
 *   data[1] === data.length - 2             (0x0E payload length)
 *   data[15] === xorChecksum(data, 2, 15)   (XOR over bytes 2..14)
 *
 * Returns the list of violations, empty when the frame is clean or is not a
 * 16-byte 0xCF frame at all. Callers only log. Three frames from one unit on
 * one firmware, with nothing from a T9148, is not enough evidence to gate a
 * widely deployed adapter: a wrong gate would silently drop every reading on
 * all three transports. Promote to a hard reject once frames from a second
 * unit confirm both invariants.
 */
export function frameIntegrityProblems(data: Buffer): string[] {
  if (data.length !== 16 || data[0] !== 0xcf || data[2] !== 0x00) return [];
  const problems: string[] = [];
  const expectedLen = data.length - 2;
  if (data[1] !== expectedLen) {
    problems.push(`length byte 0x${data[1].toString(16)} != ${expectedLen}`);
  }
  const expectedXor = xorChecksum(data, 2, 15);
  if (data[15] !== expectedXor) {
    problems.push(`xor 0x${data[15].toString(16)} != expected 0x${expectedXor.toString(16)}`);
  }
  return problems;
}

/** Parse a 16-byte weight notification frame from FFF2. Returns null if malformed. */
export function parseWeightNotification(data: Buffer): ScaleReading | null {
  if (data.length !== 16 || data[0] !== 0xcf || data[2] !== 0x00) return null;

  const weight = ((data[7] << 8) | data[6]) / 100;
  if (!Number.isFinite(weight) || weight < MIN_WEIGHT_KG || weight > MAX_WEIGHT_KG) return null;

  const isFinal = data[12] === 0x00;
  if (!isFinal) return null;

  // Bytes 8..10 are NOT a usable resistance. The upstream reference
  // (bdr99/eufylife-ble-client) keeps this decode commented out for T9148/T9149;
  // real P2/P2 Pro hardware yields millions of Ohm here (#289), which
  // computeBiaFat then clamps to a bogus fixed 60% body fat. Treat the GATT path
  // as weight-only, exactly like the broadcast path (parseEufyAdvertisement), and
  // let the shared BMI/Deurenberg fallback estimate body composition.
  return { weight, impedance: 0 };
}

/** Parse 19-byte advertisement vendor payload. Returns null if not a final reading. */
export function parseEufyAdvertisement(vendor: Buffer): ScaleReading | null {
  if (vendor.length < 19 || vendor[6] !== 0xcf) return null;

  // Final flag is at byte[15] in full 19-byte vendor payload (offset 9 after 6-byte header)
  const isFinal = vendor[15] === 0x00;
  if (!isFinal) return null;

  const weight = ((vendor[10] << 8) | vendor[9]) / 100;
  if (!Number.isFinite(weight) || weight < MIN_WEIGHT_KG || weight > MAX_WEIGHT_KG) return null;

  return { weight, impedance: 0 };
}

export class EufyP2Adapter
  implements ScaleAdapterCore, GattWiring, MultiCharNotify, BroadcastSource
{
  readonly name = 'Eufy Smart Scale P2/P2 Pro';
  readonly match: MatchDescriptor = {
    priority: 270,
    custom: true,
    names: { startsWith: ['eufy t9148', 'eufy t9149'], exact: ['eufy t9148', 'eufy t9149'] },
    manufacturerId: 0xff48,
  };
  readonly charNotifyUuid = CHR_DATA;
  readonly charWriteUuid = CHR_WRITE;
  readonly normalizesWeight = true;

  readonly characteristics: CharacteristicBinding[] = [
    { service: SVC_UUID, uuid: CHR_WRITE, type: 'write' },
    { service: SVC_UUID, uuid: CHR_DATA, type: 'notify' },
    { service: SVC_UUID, uuid: CHR_AUTH, type: 'notify' },
  ];

  private auth: EufyAuthHandler | null = null;
  private ctx: ConnectionContext | null = null;
  private readonly c3Seen = { done: false };

  /** Raw weight (hundredths of kg) of the previous final GATT frame this session. */
  private previousFinalRawWeight: number | null = null;
  /** True once two consecutive final GATT frames reported the same weight. */
  private weightStable = false;

  /** Whether an FFF2 frame-integrity mismatch has already been reported this session. */
  private frameIntegrityLogged = false;

  matches(device: BleDeviceInfo): boolean {
    const name = (device.localName || '').toLowerCase();
    if (name.startsWith('eufy t9148') || name.startsWith('eufy t9149')) return true;
    if (name === 'eufy t9148' || name === 'eufy t9149') return true;

    // Passive (broadcast) identification via manufacturer data: company 0xFF48
    // + 0xCF signature at offset 6 of the 19-byte vendor payload.
    if (device.manufacturerData) {
      const { id, data } = device.manufacturerData;
      if (id === EUFY_COMPANY_ID && data.length >= 19 && data[6] === 0xcf) {
        return true;
      }
    }
    return false;
  }

  async onConnected(ctx: ConnectionContext): Promise<void> {
    // Reset per-connection state first so a missing deviceAddress or a fresh
    // scan cannot inherit a prior session's authenticated EufyAuthHandler.
    this.ctx = ctx;
    this.auth = null;
    this.c3Seen.done = false;
    this.previousFinalRawWeight = null;
    this.weightStable = false;
    this.frameIntegrityLogged = false;
    if (!ctx.deviceAddress) {
      bleLog.warn('Eufy: no device address available — auth will fail without MAC');
      return;
    }
    this.auth = new EufyAuthHandler(ctx.deviceAddress);
    bleLog.debug('Eufy: sending C0 handshake');
    for (const frame of this.auth.buildC0()) {
      await ctx.write(CHR_WRITE, frame, true);
      await new Promise<void>((r) => setTimeout(r, EUFY_WRITE_DELAY_MS));
    }
  }

  /** Multi-char dispatch: route FFF4 to auth handler, FFF2 to weight parser. */
  parseCharNotification(charUuid: string, data: Buffer): ScaleReading | null {
    const uuid = normalizeUuid(charUuid);
    if (uuid === normalizeUuid(CHR_AUTH)) {
      this.handleAuthFrame(data);
      return null;
    }
    if (uuid === normalizeUuid(CHR_DATA)) {
      if (!this.auth?.isAuthenticated) {
        bleLog.debug('Eufy: FFF2 frame received before auth complete — ignoring');
        return null;
      }
      this.noteFrameIntegrity(data);
      return this.trackStability(parseWeightNotification(data));
    }
    return null;
  }

  /** Fallback single-char path (not used when parseCharNotification is defined). */
  parseNotification(data: Buffer): ScaleReading | null {
    this.noteFrameIntegrity(data);
    return this.trackStability(parseWeightNotification(data));
  }

  /**
   * Report an FFF2 frame that violates a #289 invariant, at most once per
   * session. Diagnostic only: the frame is parsed exactly as before either way.
   * Once per session rather than once per frame, because this runs for every
   * streaming frame and an unconditional line would flood exactly the log you
   * want to read.
   */
  private noteFrameIntegrity(data: Buffer): void {
    if (this.frameIntegrityLogged) return;
    const problems = frameIntegrityProblems(data);
    if (problems.length === 0) return;
    this.frameIntegrityLogged = true;
    bleLog.debug(
      `Eufy: FFF2 frame integrity mismatch (${problems.join('; ')}), parsed anyway (#289)`,
    );
  }

  /**
   * Record whether this final frame's weight matches the previous one, so
   * isFinal() can report the reading as settled. parseWeightNotification only
   * returns non-null for final frames, so consecutive calls compare final
   * frames to each other.
   */
  private trackStability(reading: ScaleReading | null): ScaleReading | null {
    if (!reading) return reading;
    const rawWeight = Math.round(reading.weight * 100);
    this.weightStable = this.previousFinalRawWeight === rawWeight;
    this.previousFinalRawWeight = rawWeight;
    return reading;
  }

  parseBroadcast(manufacturerData: Buffer): ScaleReading | null {
    return parseEufyAdvertisement(manufacturerData);
  }

  isComplete(reading: ScaleReading): boolean {
    // Both paths are weight-only: the broadcast advertisement carries no BIA, and
    // the GATT frame's bytes 8..10 are not a usable resistance (#289), so
    // parseWeightNotification also emits impedance 0. The impedance>0 branch is a
    // defensive no-op kept for a future real-impedance decode.
    if (reading.impedance === 0) return reading.weight > 0;
    return reading.weight > MIN_WEIGHT_KG && reading.impedance > 200;
  }

  /**
   * Hold the link open after the first final frame so the weight can settle,
   * rather than exporting the first (possibly still-drifting) final value.
   * Only the GATT path (shared.ts) consults this; the broadcast path resolves
   * on isComplete() alone, so passive reads are unaffected.
   */
  readonly completionHoldMs = WEIGHT_STABLE_HOLD_MS;

  /** Resolve immediately once the weight has stabilized across two final frames. */
  isFinal(_reading: ScaleReading): boolean {
    return this.weightStable;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    const fat =
      reading.impedance > 0 ? computeBiaFat(reading.weight, reading.impedance, profile) : undefined;
    return buildPayload(reading.weight, reading.impedance, { fat }, profile);
  }

  private handleAuthFrame(data: Buffer): void {
    if (!this.auth || !this.ctx) return;
    if (data.length === 0) return;

    if (data[0] === 0xc1) {
      if (!this.auth.handleC1(data)) return;
      bleLog.debug(`Eufy: C1 complete, device uuid received, sending C2`);
      void this.sendC2().catch((error: unknown) => {
        bleLog.warn(
          `Eufy: failed to send C2 authentication frame (${error instanceof Error ? error.message : String(error)})`,
        );
      });
      return;
    }

    if (data[0] === 0xc3) {
      if (this.c3Seen.done) return;
      this.c3Seen.done = true;
      this.auth.handleC3(data);
      if (this.auth.isAuthenticated) {
        bleLog.info('Eufy: authentication successful, waiting for weight on FFF2');
      } else {
        bleLog.warn('Eufy: authentication failed (scale rejected credentials)');
      }
    }
  }

  private async sendC2(): Promise<void> {
    if (!this.auth || !this.ctx) return;
    for (const frame of this.auth.buildC2()) {
      await this.ctx.write(CHR_WRITE, frame, true);
      await new Promise<void>((r) => setTimeout(r, EUFY_WRITE_DELAY_MS));
    }
  }
}
