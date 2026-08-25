import type { UserProfile } from '../interfaces/scale-adapter.js';
import type { BleHandlerName } from '../ble/types.js';
import type {
  AppConfig,
  UserConfig,
  ScaleConfig,
  ExporterEntry,
  WeightUnit,
  MqttProxyConfig,
  EsphomeProxyConfig,
} from './schema.js';

// --- User profile resolution ---

/**
 * Compute age from a birth date string (YYYY-MM-DD).
 */
function computeAge(birthDate: string): number {
  const [y, m, d] = birthDate.split('-').map(Number);
  const today = new Date();
  let age = today.getFullYear() - y;
  const monthDiff = today.getMonth() - (m - 1);
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < d)) {
    age--;
  }
  return age;
}

/**
 * Resolve a UserConfig + ScaleConfig into a UserProfile for body composition calculation.
 *
 * The configured `user.height` is always stored in centimeters — matching the
 * on-wire format of every scale adapter (the SIG Height characteristic, the
 * Renpho protocol, the Xiaomi S800 broadcast, etc.).  `scale.height_unit` is
 * a display-only setting used by the wizard prompt label and any future UI that
 * renders the value back to the user; it must NOT influence the internal
 * representation or the BMI calculation (weight / height_m²).
 *
 * Regression: when height_unit was 'in' the old code multiplied by 2.54, so a
 * user who wrote `height: 172` (172 cm, matching the scale's stored value) with
 * `height_unit: in` (to see inches in the UI) got a profile height of 436.88 cm
 * and a BMI of 3.8 instead of 24.79.
 */
export function resolveUserProfile(user: UserConfig, _scaleConfig: ScaleConfig): UserProfile {
  // height is always in centimeters — the unit every adapter's protocol uses on the wire.
  return {
    height: user.height,
    age: computeAge(user.birth_date),
    gender: user.gender,
    isAthlete: user.is_athlete,
    birthDate: user.birth_date,
  };
}

// --- Runtime config resolution ---

export interface ResolvedRuntimeConfig {
  profile: UserProfile;
  scaleMac?: string;
  weightUnit: WeightUnit;
  dryRun: boolean;
  continuousMode: boolean;
  scanCooldownSec: number;
  watchdogMaxFailures: number;
  watchConfig: boolean;
  bleHandler: BleHandlerName;
  bleAdapter?: string;
  mqttProxy?: MqttProxyConfig;
  esphomeProxy?: EsphomeProxyConfig;
}

/**
 * Resolve runtime config from AppConfig (uses first user as default profile).
 */
export function resolveRuntimeConfig(config: AppConfig): ResolvedRuntimeConfig {
  const user = config.users[0];
  const profile = resolveUserProfile(user, config.scale);

  return {
    profile,
    scaleMac: config.ble?.scale_mac ?? undefined,
    weightUnit: config.scale.weight_unit,
    dryRun: config.runtime?.dry_run ?? false,
    continuousMode: config.runtime?.continuous_mode ?? false,
    scanCooldownSec: config.runtime?.scan_cooldown ?? 30,
    watchdogMaxFailures: config.runtime?.watchdog_max_consecutive_failures ?? 10,
    watchConfig: config.runtime?.watch_config ?? true,
    bleHandler: config.ble?.handler ?? 'auto',
    bleAdapter: config.ble?.adapter ?? undefined,
    mqttProxy: config.ble?.mqtt_proxy ?? undefined,
    esphomeProxy: config.ble?.esphome_proxy ?? undefined,
  };
}

// --- Exporter resolution ---

/**
 * Merge user-level exporters with global exporters.
 * User exporters come first; global exporters are appended (deduped by type).
 */
export function resolveExportersForUser(config: AppConfig, user: UserConfig): ExporterEntry[] {
  const entries: ExporterEntry[] = [];
  const seenTypes = new Set<string>();

  // User-level exporters first
  if (user.exporters) {
    for (const entry of user.exporters) {
      entries.push(entry);
      seenTypes.add(entry.type);
    }
  }

  // Global exporters (skip if user already has one of the same type)
  if (config.global_exporters) {
    for (const entry of config.global_exporters) {
      if (!seenTypes.has(entry.type)) {
        entries.push(entry);
        seenTypes.add(entry.type);
      }
    }
  }

  return entries;
}

// --- Convenience: single-user resolution ---

export interface ResolvedSingleUser extends ResolvedRuntimeConfig {
  exporterEntries: ExporterEntry[];
}

/**
 * Convenience function for single-user mode.
 * Resolves profile, runtime config, and exporter entries for the first user.
 */
export function resolveForSingleUser(config: AppConfig): ResolvedSingleUser {
  const runtime = resolveRuntimeConfig(config);
  const user = config.users[0];
  const exporterEntries = resolveExportersForUser(config, user);

  return {
    ...runtime,
    exporterEntries,
  };
}
