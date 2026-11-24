import { pool } from '../db.js';
import { normalizeIdentity } from '../core/normalize.js';
import { ingest } from './ingest.js';
import { log } from '../core/logger.js';
import type { Channel, Direction } from '../core/types.js';

/**
 * Consent-check API logic (ADR-0004, Class B). A sending service asks, before
 * sending: may this go out to this identity on this system? The answer is a
 * pure read of the consent_states projection — no new consent logic. Because
 * opt-out propagation and the reconciler backfill (DESIGN §8.5) already put a
 * `suppressed` row on every active in-scope system, a check for (identity,
 * system) automatically reflects opt-outs that originated on other platforms.
 *
 * The hub is a SUPPRESSION authority, not a consent-grant authority: a
 * `suppress` answer is binding; an `allow` answer means only "no revocation on
 * record" and carries an advisory so it can't be read as consent (§2.1).
 */

export type CheckMode = 'blocklist' | 'allowlist';
export type Decision = 'suppress' | 'allow' | 'error';
type ProjState = 'unknown' | 'opted_in' | 'opted_out' | 'suppressed';

export interface CheckResult {
  identity: string;
  normalized: string | null;
  decision: Decision;
  state: ProjState | null;
  scope: { system: string; channel: Channel };
  reason: string;
  as_of: string | null;
  advisory: string | null;
}

export const ADVISORY =
  'Not a consent grant; the sender remains responsible for its own lawful basis to contact.';

/** Thrown for request-level problems (bad system/channel) → HTTP 400. */
export class CheckRequestError extends Error {}

/**
 * The decision, isolated and pure for unit testing. `suppress` on any opt-out
 * or propagated suppression; `allow` on a positive opt-in; and for `unknown`
 * the posture decides — blocklist sends (unknown→allow), allowlist withholds.
 */
export function mapDecision(
  state: ProjState,
  mode: CheckMode,
): { decision: 'suppress' | 'allow'; advisory: boolean } {
  if (state === 'opted_out' || state === 'suppressed') return { decision: 'suppress', advisory: false };
  if (state === 'opted_in') return { decision: 'allow', advisory: false };
  // unknown: no record for this identity/system
  if (mode === 'allowlist') return { decision: 'suppress', advisory: true };
  return { decision: 'allow', advisory: true };
}

/** Pure: does this projected state mean "withhold sends"? */
export function isSuppressingState(state: ProjState): boolean {
  return state === 'opted_out' || state === 'suppressed';
}

/**
 * Pure: the high-watermark a feed client should pass back as `since` next sync.
 * The newest entry timestamp if any rows came back; otherwise the caller's
 * `since` (nothing changed — keep the cursor); otherwise `now` (empty baseline).
 */
export function suppressionWatermark(
  entryTimes: string[],
  sinceIso: string | undefined,
  nowIso: string,
): string {
  if (entryTimes.length) return entryTimes.reduce((a, b) => (a > b ? a : b));
  return sinceIso ?? nowIso;
}

export interface SuppressionEntry {
  identity: string;                 // value_normalized
  state: ProjState;
  suppressed: boolean;              // isSuppressingState(state)
  as_of: string;
}

export interface SuppressionFeed {
  system: string;
  channel: Channel;
  as_of: string;                    // pass back as ?since on the next sync
  full: boolean;                    // true = baseline (no since); false = delta
  entries: SuppressionEntry[];
}

/**
 * Suppression sync feed for a Class B sender's local cache (ADR-0004 §2.4/§6).
 * The live per-identity check is for freshness; this feed is for availability —
 * a sender keeps a hub-synced suppression list so a hub outage degrades to the
 * last-known state instead of withholding every send.
 *
 * Without `since`: the baseline — every identity currently in a suppressing
 * state for this system. With `since`: a delta — every row whose projection
 * changed after that instant, in ANY state, so the client can both add newly
 * suppressed identities and drop ones that were un-suppressed (e.g. an approved
 * re-opt-in). `updated_at` is bumped on every recompute, so the delta is
 * over-inclusive, never lossy.
 */
export async function listSuppressions(
  systemId: string,
  sinceIso: string | undefined,
  nowIso: string,
): Promise<SuppressionFeed> {
  const sys = await pool.query<{ channel: Channel }>(
    `SELECT channel FROM systems WHERE id=$1 AND archived_at IS NULL`,
    [systemId],
  );
  if (sys.rowCount === 0) throw new CheckRequestError(`unknown or archived system: ${systemId}`);
  const channel = sys.rows[0].channel;

  let since: Date | null = null;
  if (sinceIso !== undefined) {
    const d = new Date(sinceIso);
    if (Number.isNaN(d.getTime())) throw new CheckRequestError('invalid "since" timestamp (expected ISO-8601)');
    since = d;
  }

  const r = since
    ? await pool.query<{ value_normalized: string; state: ProjState; updated_at: Date }>(
        `SELECT i.value_normalized, cs.state, cs.updated_at
           FROM consent_states cs JOIN identities i ON i.id = cs.identity_id
          WHERE cs.system_id = $1 AND cs.updated_at > $2
          ORDER BY cs.updated_at ASC`,
        [systemId, since],
      )
    : await pool.query<{ value_normalized: string; state: ProjState; updated_at: Date }>(
        `SELECT i.value_normalized, cs.state, cs.updated_at
           FROM consent_states cs JOIN identities i ON i.id = cs.identity_id
          WHERE cs.system_id = $1 AND cs.state IN ('opted_out','suppressed')
          ORDER BY cs.updated_at ASC`,
        [systemId],
      );

  const entries: SuppressionEntry[] = r.rows.map((row) => ({
    identity: row.value_normalized,
    state: row.state,
    suppressed: isSuppressingState(row.state),
    as_of: row.updated_at.toISOString(),
  }));

  return {
    system: systemId,
    channel,
    as_of: suppressionWatermark(entries.map((e) => e.as_of), sinceIso, nowIso),
    full: since === null,
    entries,
  };
}

function reasonFor(state: ProjState): string {
  switch (state) {
    case 'opted_out': return 'explicit opt-out on record for this system';
    case 'suppressed': return 'suppressed — opt-out propagated from another platform';
    case 'opted_in': return 'opted in on this system';
    case 'unknown': return 'no suppression on record';
  }
}

/**
 * Run a batch check. Validates the system/channel, normalizes each identity,
 * reads the projection, maps decisions, and records the check audit. Throws
 * CheckRequestError for request-level problems.
 */
export async function checkConsent(
  systemId: string,
  channel: string,
  identities: string[],
  mode: CheckMode,
  apiKeyId: number | null,
): Promise<CheckResult[]> {
  if (channel !== 'sms' && channel !== 'email') {
    throw new CheckRequestError('channel must be "sms" or "email"');
  }
  const sys = await pool.query<{ channel: Channel }>(
    `SELECT channel FROM systems WHERE id=$1 AND archived_at IS NULL`,
    [systemId],
  );
  if (sys.rowCount === 0) {
    throw new CheckRequestError(`unknown or archived system: ${systemId}`);
  }
  const sysChannel = sys.rows[0].channel;
  if (sysChannel !== channel) {
    throw new CheckRequestError(
      `channel ${channel} does not match system channel ${sysChannel}`,
    );
  }
  const scope = { system: systemId, channel: sysChannel };

  // Normalize first; look up the projection for everything that normalized.
  const normed = identities.map((raw) => ({ raw, n: normalizeIdentity(raw) }));
  const values = normed.filter((x) => x.n).map((x) => x.n!.normalized);

  const stateByValue = new Map<string, { state: ProjState; as_of: Date | null }>();
  if (values.length) {
    const r = await pool.query<{ value_normalized: string; state: ProjState | null; updated_at: Date | null }>(
      `SELECT i.value_normalized, cs.state, cs.updated_at
         FROM identities i
         LEFT JOIN consent_states cs ON cs.identity_id = i.id AND cs.system_id = $2
        WHERE i.value_normalized = ANY($1)`,
      [values, systemId],
    );
    for (const row of r.rows) {
      stateByValue.set(row.value_normalized, {
        state: (row.state ?? 'unknown') as ProjState,
        as_of: row.updated_at,
      });
    }
  }

  const results: CheckResult[] = [];
  for (const { raw, n } of normed) {
    if (!n) {
      results.push({
        identity: raw, normalized: null, decision: 'error', state: null,
        scope, reason: 'unrecognized identity format', as_of: null, advisory: null,
      });
      continue;
    }
    // A phone can't be checked against an email system (or vice versa).
    const kindChannel: Channel = n.kind === 'phone' ? 'sms' : 'email';
    if (kindChannel !== sysChannel) {
      results.push({
        identity: raw, normalized: n.normalized, decision: 'error', state: null,
        scope, reason: `identity is ${n.kind} but system channel is ${sysChannel}`,
        as_of: null, advisory: null,
      });
      continue;
    }
    const hit = stateByValue.get(n.normalized);
    const state: ProjState = hit ? hit.state : 'unknown';
    const { decision, advisory } = mapDecision(state, mode);
    results.push({
      identity: raw,
      normalized: n.normalized,
      decision,
      state,
      scope,
      reason: reasonFor(state),
      as_of: hit?.as_of ? hit.as_of.toISOString() : null,
      advisory: advisory ? ADVISORY : null,
    });
  }

  await recordChecks(systemId, sysChannel, apiKeyId, results);
  return results;
}

/**
 * Write the check audit (item 3), persisting the FULL response returned to the
 * caller (decision, state, reason, as_of, advisory) — ADR-0004 §7.
 *
 * The two decision classes are recorded with different durability guarantees:
 *   - `suppress` — the § 227(c)(5) affirmative-defense evidence. Its write is
 *     GUARANTEED: on failure we retry once and then surface the error, so a
 *     suppress is never returned to a sender without a durable record (the
 *     check fails → the sender fails closed, which is the safe outcome).
 *   - `allow` / `error` — high-volume operational noise; stays best-effort so
 *     an audit-write blip never breaks a routine send.
 */
async function recordChecks(
  systemId: string,
  channel: Channel,
  apiKeyId: number | null,
  results: CheckResult[],
): Promise<void> {
  const suppress = results.filter((r) => r.decision === 'suppress');
  const other = results.filter((r) => r.decision !== 'suppress');

  if (other.length) {
    try {
      await insertChecks(systemId, channel, apiKeyId, other);
    } catch (e) {
      log.warn('consent_check_audit_write_failed', {
        system: systemId, decisions: 'allow/error', count: other.length,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  if (suppress.length) {
    try {
      await insertChecks(systemId, channel, apiKeyId, suppress);
    } catch {
      // Retry once, then surface — a suppress must not be returned unlogged.
      try {
        await insertChecks(systemId, channel, apiKeyId, suppress);
      } catch (e) {
        log.error('consent_check_suppress_audit_failed', {
          system: systemId, channel, count: suppress.length,
          error: e instanceof Error ? e.message : String(e),
        });
        throw e;
      }
    }
  }
}

/** One multi-row insert of check-audit rows, including the full returned response. */
async function insertChecks(
  systemId: string,
  channel: Channel,
  apiKeyId: number | null,
  results: CheckResult[],
): Promise<void> {
  const params: unknown[] = [systemId, channel, apiKeyId];
  const tuples = results
    .map((r, i) => {
      const b = i * 6;
      params.push(r.normalized ?? r.identity, r.decision, r.state, r.reason, r.as_of, r.advisory);
      return `($1,$2,$3,$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9})`;
    })
    .join(',');
  await pool.query(
    `INSERT INTO consent_checks
       (system_id, channel, api_key_id, identity_norm, decision, state, reason, as_of, advisory)
     VALUES ${tuples}`,
    params,
  );
}

// ---- Sender-reported consent events (opt-out/opt-in ingestion) --------------

export interface ReportInput {
  value: string;                     // raw phone/email as the sender saw it
  direction: Direction;              // 'opt_out' | 'opt_in'
  occurred_at?: string;              // ISO-8601; defaults to now
  source?: string;                   // free-text provenance note
}

/**
 * Pure: validate + parse a report request. Throws CheckRequestError on bad
 * input; returns the normalized identity and parsed timestamp. Exported for
 * testing (the system-existence check is done separately, against the DB).
 */
export function validateReportInput(input: ReportInput): { direction: Direction; normalized: string; occurred_at?: Date } {
  if (input.direction !== 'opt_out' && input.direction !== 'opt_in') {
    throw new CheckRequestError('direction must be "opt_out" or "opt_in"');
  }
  if (!input.value || typeof input.value !== 'string') throw new CheckRequestError('value is required');
  const norm = normalizeIdentity(input.value);
  if (!norm) throw new CheckRequestError(`could not normalize value: ${input.value}`);

  let occurred_at: Date | undefined;
  if (input.occurred_at !== undefined) {
    const d = new Date(input.occurred_at);
    if (Number.isNaN(d.getTime())) throw new CheckRequestError('invalid occurred_at (expected ISO-8601)');
    occurred_at = d;
  }
  return { direction: input.direction, normalized: norm.normalized, occurred_at };
}

/**
 * Record a consent event a trusted sender observed (e.g. a Twilio STOP its own
 * inbound webhook received), scoped to the sender's own system. This is the
 * write counterpart to the consent-check API: it lets a sender feed opt-outs to
 * the hub WITHOUT repointing the platform's inbound webhook away from the
 * sender's app. Ingests through the same path as a hub webhook, so propagation,
 * precedence, and audit behave identically. Throws CheckRequestError on bad input.
 */
export async function reportConsent(systemId: string, input: ReportInput): Promise<{ ok: true; normalized: string; direction: Direction }> {
  const sys = await pool.query(`SELECT 1 FROM systems WHERE id=$1 AND archived_at IS NULL`, [systemId]);
  if (sys.rowCount === 0) throw new CheckRequestError(`unknown or archived system: ${systemId}`);

  const { direction, normalized, occurred_at } = validateReportInput(input);
  const source_detail = `sender report${input.source ? `: ${input.source}` : ''}`;
  await ingest({
    system_id: systemId,
    identity_value: input.value,
    direction,
    occurred_at,
    source_detail,
    // Explicit opt-ins require evidence; carry the reported provenance.
    ...(direction === 'opt_in' ? { evidence: { method: source_detail } } : {}),
  });
  return { ok: true, normalized, direction };
}
