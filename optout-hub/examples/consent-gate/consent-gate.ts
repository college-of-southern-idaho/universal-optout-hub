/**
 * Reference consent gate for a Class B sender (ADR-0004).
 *
 * This is example integration code for the ORG'S OWN sending app — e.g. the
 * custom Twilio texting solution — not part of the hub. The hub is never in the
 * send path; enforcement for a withhold-only platform like Twilio happens here,
 * in the sender, by asking the hub before every send and FAILING CLOSED.
 *
 * Drop this file into your sender and call `mayContact()` before dispatching.
 */

import type { SuppressionCache } from './suppression-cache.js';

export interface GateConfig {
  hubUrl: string;          // e.g. https://hub.example.edu  (no trailing slash needed)
  apiKey: string;          // oohk_... issued for this system (Admin → Services → API keys)
  system: string;          // the registered system id the key is scoped to
  channel: 'sms' | 'email';
  timeoutMs?: number;      // per-request timeout; default 2000. On timeout we fall back / fail closed.
  /**
   * Optional hub-synced suppression cache (ADR-0004 §2.4). When present, a hub
   * OUTAGE (5xx / timeout / network error) degrades to this last-known list
   * instead of withholding everything. Auth/request errors (4xx) still fail
   * closed — those signal misconfiguration, not an outage. Keep it fed with
   * `syncSuppressions()` from `suppression-cache.ts`.
   */
  cache?: SuppressionCache;
  /**
   * Normalize a recipient the SAME way the hub does so cache lookups match its
   * `value_normalized`. Default handles common forms (E.164-ish phone,
   * lower-cased email); production senders should plug in the exact
   * normalization the hub uses (e.g. libphonenumber) to avoid drift.
   */
  normalize?: (raw: string) => string;
}

export interface GateDecision {
  identity: string;
  send: boolean;
  reason: string;
}

/** The subset of a /api/v1/consent/check result this client needs. */
interface CheckResult {
  identity: string;
  decision: 'suppress' | 'allow' | 'error';
  reason?: string;
}

/**
 * Pure: map a single check result (or a failure, represented as null) to a
 * send/withhold decision — FAILING CLOSED. Only an explicit `allow` permits a
 * send; a suppression, an un-evaluable identity, or any hub failure withholds.
 * Over-suppression carries no penalty; under-suppression does (DESIGN §2.4).
 */
export function decide(result: CheckResult | null, identity: string): GateDecision {
  if (result && result.decision === 'allow') {
    return { identity, send: true, reason: result.reason ?? 'no suppression on record' };
  }
  if (result && result.decision === 'suppress') {
    return { identity, send: false, reason: result.reason ?? 'suppressed' };
  }
  if (result && result.decision === 'error') {
    return { identity, send: false, reason: `fail-closed: hub could not evaluate identity (${result.reason ?? 'error'})` };
  }
  return { identity, send: false, reason: 'fail-closed: hub unavailable or unexpected response' };
}

/**
 * Default normalization for cache lookups. Lower-cases email; strips a phone to
 * its `+` and digits. Intended to match the hub's canonical forms for the
 * identities the README tells senders to pass (E.164 phone, plain email).
 * Replace via `GateConfig.normalize` with the hub's exact normalization in
 * production to guarantee parity.
 */
export function defaultNormalize(raw: string): string {
  const s = raw.trim();
  if (s.includes('@')) return s.toLowerCase();
  return s.replace(/[^\d+]/g, '');
}

/**
 * Pure: the decision when the hub gave NO answer (outage). With a cache that
 * has synced at least once, degrade to the last-known suppression list — on it
 * → withhold, not on it → send (last-known says not suppressed). Without a
 * ready cache there is no last-known state, so fail closed.
 */
export function decideFallback(
  cache: SuppressionCache | undefined,
  identity: string,
  normalize: (raw: string) => string,
): GateDecision {
  if (!cache || !cache.ready) {
    return { identity, send: false, reason: 'fail-closed: hub unavailable and no cached suppression list yet' };
  }
  if (cache.isSuppressed(normalize(identity))) {
    return { identity, send: false, reason: 'withheld from last-known suppression list (hub unavailable)' };
  }
  return { identity, send: true, reason: 'sent per last-known suppression list (hub unavailable)' };
}

/**
 * Ask the hub whether each identity may be contacted on this system/channel.
 * Batches into one request (the recommended pattern — check a campaign's whole
 * recipient list up front).
 *
 * On a hub OUTAGE (5xx, timeout, network error) and a ready `cfg.cache`, each
 * identity degrades to the last-known suppression list; otherwise — including
 * any 4xx (auth/scope/rate-limit/bad request) — every identity fails closed.
 */
export async function mayContact(cfg: GateConfig, identities: string[]): Promise<GateDecision[]> {
  const normalize = cfg.normalize ?? defaultNormalize;
  const onOutage = () => identities.map((id) => decideFallback(cfg.cache, id, normalize));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? 2000);
  try {
    const res = await fetch(`${cfg.hubUrl.replace(/\/+$/, '')}/api/v1/consent/check`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ system: cfg.system, channel: cfg.channel, identities }),
      signal: controller.signal,
    });
    if (!res.ok) {
      // 5xx is an outage → fall back to cache if we have one. A 4xx is a
      // misconfiguration (bad key, wrong scope, rate limit) — never mask it
      // with stale data; fail closed.
      if (res.status >= 500) return onOutage();
      return identities.map((id) => decide(null, id));
    }
    const body = (await res.json()) as { results: CheckResult[] };
    const byId = new Map((body.results ?? []).map((r) => [r.identity, r]));
    return identities.map((id) => decide(byId.get(id) ?? null, id));
  } catch {
    // Network error, timeout, or abort → treat as an outage.
    return onOutage();
  } finally {
    clearTimeout(timer);
  }
}
