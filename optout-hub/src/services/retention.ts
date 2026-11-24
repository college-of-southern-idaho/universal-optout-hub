import { pool } from '../db.js';
import { policy } from '../core/policy.js';

/**
 * Split-retention prune for the `consent_checks` audit table (ADR-0004 §7).
 *
 * Every consent check is logged. The two decision classes carry very different
 * value and volume, so they age out on separate clocks:
 *   - `suppress` — a send was withheld; the § 227(c)(5) affirmative-defense
 *     evidence, kept ~4 years (statute).
 *   - everything else (`allow`, `error`) — high-volume operational noise, kept
 *     far shorter (default 90 days).
 *
 * The prune is on-demand (admin route) mirroring the reconciler; production
 * runs it on a schedule (cron / job runner) the same way it schedules
 * reconciliation. The core decision — is a row past its window — is a pure
 * function so it can be unit-tested without a database (the repo's posture).
 */

export interface RetentionWindows {
  suppressDays: number;
  otherDays: number;
}

/** Current windows from policy (env-overridable). */
export function retentionWindows(): RetentionWindows {
  return {
    suppressDays: policy.consentCheckRetainSuppressDays,
    otherDays: policy.consentCheckRetainOtherDays,
  };
}

const MS_PER_DAY = 86_400_000;

/**
 * Pure: is a row past its retention window? `suppress` uses the long window,
 * every other decision the short one. Boundary is exclusive — a row exactly at
 * the window is kept; only strictly-older rows prune.
 */
export function isExpired(
  decision: string,
  checkedAtMs: number,
  nowMs: number,
  w: RetentionWindows,
): boolean {
  const keepDays = decision === 'suppress' ? w.suppressDays : w.otherDays;
  const ageDays = (nowMs - checkedAtMs) / MS_PER_DAY;
  return ageDays > keepDays;
}

export interface PruneResult {
  suppress_pruned: number;
  other_pruned: number;
  suppress_days: number;
  other_days: number;
}

/**
 * Delete `consent_checks` rows past their retention window in one transaction,
 * and audit the counts. Two indexed DELETEs (the `(decision, checked_at)` index
 * from migration 009 covers both). Returns per-class counts.
 */
export async function pruneConsentChecks(
  actor: string | null = null,
  w: RetentionWindows = retentionWindows(),
): Promise<PruneResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sup = await client.query(
      `DELETE FROM consent_checks
        WHERE decision = 'suppress'
          AND checked_at < now() - make_interval(days => $1)`,
      [Math.floor(w.suppressDays)],
    );
    const oth = await client.query(
      `DELETE FROM consent_checks
        WHERE decision <> 'suppress'
          AND checked_at < now() - make_interval(days => $1)`,
      [Math.floor(w.otherDays)],
    );
    const result: PruneResult = {
      suppress_pruned: sup.rowCount ?? 0,
      other_pruned: oth.rowCount ?? 0,
      suppress_days: w.suppressDays,
      other_days: w.otherDays,
    };
    await client.query(
      `INSERT INTO audit_log (actor, action, detail) VALUES ($1,'consent_checks.prune',$2)`,
      [actor, result],
    );
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Operational audit_log retention (DESIGN.md §14).
 *
 * The audit_log (migration 001) is a secondary operational activity trail —
 * ingestion/reconcile/alert/prune breadcrumbs that duplicate durable tables
 * (consent_events, approval_requests, consent_checks). It had no prune and grew
 * unbounded. We prune it on a window (default 14 days) EXCEPT a small set of
 * low-volume, compliance-relevant action types kept indefinitely: approval
 * decisions and auto-cancels (the § 227(c)(5) trail's breadcrumb), configuration
 * changes (audit_log is the ONLY record of config history), and API-key
 * create/revoke. The authoritative legal evidence never lived here.
 */
export const AUDIT_RETAINED_ACTIONS = [
  'review_decided',
  'review_auto_canceled',
  'config.update',
  'api_key.create',
  'api_key.revoke',
] as const;

/** Current operational-audit retention window from policy (env-overridable). */
export function auditLogRetainDays(): number {
  return policy.auditLogRetainDays;
}

/**
 * Pure: is an audit_log row prunable? Compliance-relevant actions are never
 * pruned; everything else prunes once strictly older than the window. Boundary
 * exclusive (a row exactly at the window is kept) and future-dated rows (clock
 * skew) are never prunable — matching isExpired.
 */
export function isAuditPrunable(action: string, atMs: number, nowMs: number, retainDays: number): boolean {
  if ((AUDIT_RETAINED_ACTIONS as readonly string[]).includes(action)) return false;
  const ageDays = (nowMs - atMs) / MS_PER_DAY;
  return ageDays > retainDays;
}

export interface AuditPruneResult {
  pruned: number;
  retain_days: number;
  retained_actions: string[];
}

/**
 * Delete operational audit_log rows past the retention window, keeping the
 * compliance-relevant actions. One indexed DELETE (migration 019's index on
 * `at`), then its own `audit_log.prune` breadcrumb (not in the retained set, so
 * it ages out normally on a later run). Wrapped in a transaction to mirror
 * pruneConsentChecks.
 */
export async function pruneAuditLog(
  actor: string | null = null,
  retainDays: number = auditLogRetainDays(),
): Promise<AuditPruneResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const del = await client.query(
      `DELETE FROM audit_log
        WHERE at < now() - make_interval(days => $1)
          AND action <> ALL($2::text[])`,
      [Math.floor(retainDays), [...AUDIT_RETAINED_ACTIONS]],
    );
    const result: AuditPruneResult = {
      pruned: del.rowCount ?? 0,
      retain_days: retainDays,
      retained_actions: [...AUDIT_RETAINED_ACTIONS],
    };
    await client.query(
      `INSERT INTO audit_log (actor, action, detail) VALUES ($1,'audit_log.prune',$2)`,
      [actor, result],
    );
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
