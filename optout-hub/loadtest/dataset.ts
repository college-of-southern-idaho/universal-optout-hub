/**
 * Shared, deterministic dataset for load testing (seed + generator agree without
 * exchanging a huge list of identities). Everything is derived from an integer
 * index, so the seeder inserts exactly the values the generator will later send.
 *
 * Synthetic ranges are chosen so load data is (a) structurally valid to the
 * normalizer and (b) trivially patternable for cleanup, and can never collide
 * with real traffic:
 *   - phones: +1 555 EXCH LINE  (555 is a reserved/fictional NANP area code)
 *   - emails: lt<i>@loadtest.invalid  (.invalid is a reserved, un-routable TLD)
 *   - systems: lt_sys_<k>
 */

export interface LoadConfig {
  /** Number of mock systems. Alternating sms/email. */
  systems: number;
  /**
   * Identities PER CHANNEL. The identities table holds `2 * identities` rows
   * (one phone pool + one email pool) so both sms and email systems have depth.
   */
  identities: number;
  /** Fraction of (identity, system) pairs seeded as an explicit opt-out. */
  optOutRatio: number;
  /** Fraction seeded as a derived suppression. */
  suppressedRatio: number;
  /** Fraction seeded as an explicit opt-in. The remainder have no row (unknown). */
  optInRatio: number;
}

export const DEFAULT_CONFIG: LoadConfig = {
  systems: 6,
  identities: 200_000,
  optOutRatio: 0.2,
  suppressedRatio: 0.05,
  optInRatio: 0.15,
};

export const SYSTEM_PREFIX = 'lt_sys_';
export const PHONE_PATTERN = '+1555%'; // for cleanup
export const EMAIL_DOMAIN = 'loadtest.invalid';

export type Channel = 'sms' | 'email';

export function systemIdFor(k: number): string {
  return `${SYSTEM_PREFIX}${k}`;
}

/** Alternate channels so a mixed run touches both projections. */
export function channelFor(k: number): Channel {
  return k % 2 === 0 ? 'sms' : 'email';
}

/**
 * A structurally-valid E.164 number in the fictional +1 (555) range.
 * Capacity is 800 * 10_000 = 8,000,000 distinct numbers (i in [0, 8e6)).
 */
export function phoneFor(i: number): string {
  const exch = 200 + (Math.floor(i / 10_000) % 800); // 200..999 → leading digit 2-9
  const line = i % 10_000;
  return `+1555${exch}${String(line).padStart(4, '0')}`;
}

export function emailFor(i: number): string {
  return `lt${i}@${EMAIL_DOMAIN}`;
}

/** The identity value a given system should be queried/reported with. */
export function identityFor(channel: Channel, i: number): string {
  return channel === 'sms' ? phoneFor(i) : emailFor(i);
}

export type SeedState = 'opted_out' | 'suppressed' | 'opted_in' | null;

/**
 * Deterministic per-(identity, system) seed state. A cheap integer hash spreads
 * identities across the configured buckets; the remainder get no row at all
 * (projected as 'unknown'), which is the realistic majority case.
 */
export function seedStateFor(i: number, k: number, cfg: LoadConfig): SeedState {
  const h = ((i * 2654435761) ^ (k * 40503)) >>> 0;
  const r = (h % 100_000) / 100_000; // [0,1)
  const out = cfg.optOutRatio;
  const supp = out + cfg.suppressedRatio;
  const inn = supp + cfg.optInRatio;
  if (r < out) return 'opted_out';
  if (r < supp) return 'suppressed';
  if (r < inn) return 'opted_in';
  return null;
}

export function provenanceFor(state: Exclude<SeedState, null>): 'explicit' | 'derived' {
  return state === 'suppressed' ? 'derived' : 'explicit';
}

/** Shape of loadtest/keys.json, written by the seeder and read by the generator. */
export interface KeysFile {
  baseUrl: string;
  config: LoadConfig;
  systems: Array<{ id: string; channel: Channel; apiKey: string }>;
}
