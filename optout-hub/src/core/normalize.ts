/**
 * Identity normalization (DESIGN.md §4). All normalization happens before
 * anything reaches the sync engine. Raw input is preserved alongside the
 * normalized form for audit.
 */

import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import { policy } from './policy.js';

export interface NormalizedIdentity {
  kind: 'phone' | 'email';
  normalized: string;
  raw: string;
}

/**
 * Normalize a phone number to E.164 using libphonenumber metadata, so numbers
 * from any country land in one canonical form. Numbers without a country code
 * are parsed against DEFAULT_REGION.
 *
 * Acceptance uses isPossible() (structurally plausible length/shape) rather
 * than isValid() (assigned-range check): a consent hub must be able to record
 * an opt-out for any plausible number — over-suppression is harmless, but
 * wrongly rejecting a real number as "invalid" would drop a suppression.
 * Structurally-impossible input (wrong length, letters) is still rejected.
 */
export function normalizePhone(raw: string): string | null {
  // Region for national-format numbers comes from the live config
  // (policy.defaultPhoneRegion, DB-managed); defaults to US.
  const region = ((policy.defaultPhoneRegion || 'US').toUpperCase()) as CountryCode;
  const parsed = parsePhoneNumberFromString(raw ?? '', region);
  if (!parsed || !parsed.isPossible()) return null;
  return parsed.number; // E.164, e.g. +12084207280
}

/**
 * Conservative email canonicalization (DESIGN.md §4 default):
 * lowercase the whole address; treat plus-addressed variants and
 * dotted local parts as DISTINCT identities unless configured otherwise.
 */
export function normalizeEmail(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  // Minimal structural check — not full RFC validation.
  const m = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.exec(trimmed);
  return m ? trimmed : null;
}

export function normalizeIdentity(raw: string): NormalizedIdentity | null {
  if (raw.includes('@')) {
    const email = normalizeEmail(raw);
    return email ? { kind: 'email', normalized: email, raw } : null;
  }
  const phone = normalizePhone(raw);
  return phone ? { kind: 'phone', normalized: phone, raw } : null;
}
