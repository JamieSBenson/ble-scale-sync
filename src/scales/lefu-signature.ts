import type { BleDeviceInfo } from '../interfaces/scale-adapter.js';
import { uuidClaimHits } from './match-descriptor.js';

/**
 * Shared advertisement fingerprint for Lefu OEM stock units sold as the Hutbit
 * 218008 / WL292 (#254, #278).
 *
 * This lives in its own module rather than in `hutbit.ts` because both the
 * Hutbit adapter (to claim the unit) and the Robi S9 adapter (to bow out of it)
 * need the exact same predicate, and adapters do not import each other. The
 * established alternatives were both worse: inlining the constant twice
 * (as `mi-scale-2.ts` does with Beurer's company id) lets the two copies drift
 * apart, and drift here is a live-device false-match rather than a cosmetic bug.
 *
 * Both callers MUST use this one predicate. An asymmetric pair, where Robi bows
 * out of a wider set than the Hutbit claims, would strand a device between the
 * two: rejected by Robi, unclaimed by Hutbit, and swept up by MGB on the bare
 * FFB0 service, whose parser rejects every frame this family sends.
 */

/**
 * Company id in the advertisement's manufacturer data.
 *
 * SIG-assigned to RTB Elektronik GmbH & Co. KG, not to Lefu. The Lefu firmware
 * squats on it, which is exactly why this is a weak family marker rather than a
 * model fingerprint, and why it is only ever used gated behind the advertised
 * service UUIDs below (compare `match-descriptor.ts`, which documents
 * `manufacturerId` as "a weak signal on its own").
 */
const LEFU_COMPANY_ID = 0x02ac;

/** Vendor GATT service every FFB0-family Lefu unit advertises. */
const SVC_FFB0 = 'ffb0';

/**
 * Second service in the same advertising data element as FFB0 on the observed
 * unit. Almost certainly a generic Lefu OEM service rather than a Hutbit
 * marker, so it narrows this claim against unrelated devices squatting on
 * RTB Elektronik's company id, and probably does NOT discriminate the Hutbit
 * from a Robi S9 or an MGB. It fails closed and costs nothing on the captured
 * advertisement, so it is required until someone with MGB or Robi hardware
 * reports whether those units carry it too (#278).
 */
const SVC_D618 = 'd618';

/**
 * True when the advertisement carries the Lefu OEM stock fingerprint of a
 * Hutbit 218008: manufacturer data under company id 0x02AC whose payload is the
 * device's own MAC reversed, optionally followed by a status byte
 * (0x00 idle / 0x01 active), advertised alongside both the FFB0 and D618
 * services.
 *
 * Two payload shapes are attested by hardware:
 *
 *   7 bytes  `7EB893ECB303|01`  MAC 03:B3:EC:93:B8:7E, nRF capture in #278
 *   6 bytes  `12A291ECB303`     MAC 03:B3:EC:91:A2:12, debug log in #318
 *
 * The 6-byte form omits the status byte entirely. Requiring 7 was what sent
 * #318's unit to the MGB adapter, whose parser rejects every AC02 frame this
 * family sends, so the length check accepts both and the status byte is only
 * validated when it is present.
 *
 * Only the shape is checked, not the MAC itself: `BleDeviceInfo` carries no
 * address field, and a MAC check would not disambiguate anyway, since every
 * device in this family reverses its own MAC.
 *
 * Why an advertisement fingerprint at all: the branded unit advertises
 * "Hutbit Scale", but Lefu OEM stock advertises "SWAN", and over the ESPHome
 * proxy the local name arrives empty because it lives in the scan response.
 * The manufacturer data and service list ride in the advertisement proper, so
 * they survive every transport that populates `manufacturerData`.
 */
export function isHutbitOemAdvert(device: BleDeviceInfo): boolean {
  const m = device.manufacturerData;
  if (m?.id !== LEFU_COMPANY_ID) return false;
  if (m.data.length !== 6 && m.data.length !== 7) return false;
  if (m.data.length === 7 && m.data[6] !== 0x00 && m.data[6] !== 0x01) return false;
  return (
    uuidClaimHits([SVC_FFB0], device.serviceUuids) && uuidClaimHits([SVC_D618], device.serviceUuids)
  );
}

export { LEFU_COMPANY_ID };
