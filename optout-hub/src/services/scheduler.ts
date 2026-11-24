import { reconcile } from './reconciler.js';
import { pruneConsentChecks, pruneAuditLog } from './retention.js';
import { pruneWebhookEvents } from './webhook-dedup.js';
import { pollAll } from './poller.js';
import { scanSyncLag } from './alerting.js';
import { pool } from '../db.js';
import { policy } from '../core/policy.js';

/**
 * In-process background scheduler for the two maintenance jobs that were
 * on-demand in the PoC: reconciliation (DESIGN §8) and the consent-check audit
 * prune (ADR-0004 §7). Both still have their admin routes; this runs them on a
 * timer as well.
 *
 * Deliberately simple — the PoC is single-process (no job queue). A multi-
 * instance deployment must run these from ONE place (a leader, a cron sidecar,
 * or an external scheduler hitting the routes) rather than every instance;
 * see PRODUCTION-READINESS.md. Intervals come from the environment and default
 * to disabled, so behavior is unchanged until a deployment opts in.
 */

const MINUTE = 60_000;
const HOUR = 3_600_000;

export interface ScheduleConfig {
  reconcileEveryMs: number; // 0 = disabled
  pruneEveryMs: number;     // 0 = disabled
  pollEveryMs: number;      // 0 = disabled
  alertEveryMs: number;     // 0 = disabled
}

/**
 * Pure: convert interval values (minutes/hours) to milliseconds. Zero, negative,
 * or non-numeric → that job is disabled (0).
 */
export function scheduleFrom(reconcileMinutes: number, pruneHours: number, pollMinutes: number, alertMinutes: number): ScheduleConfig {
  const ok = (n: number) => Number.isFinite(n) && n > 0;
  return {
    reconcileEveryMs: ok(reconcileMinutes) ? Math.round(reconcileMinutes * MINUTE) : 0,
    pruneEveryMs: ok(pruneHours) ? Math.round(pruneHours * HOUR) : 0,
    pollEveryMs: ok(pollMinutes) ? Math.round(pollMinutes * MINUTE) : 0,
    alertEveryMs: ok(alertMinutes) ? Math.round(alertMinutes * MINUTE) : 0,
  };
}

/** The schedule from the live policy (DB-managed intervals). */
export function currentSchedule(): ScheduleConfig {
  return scheduleFrom(policy.reconcileIntervalMinutes, policy.pruneIntervalHours, policy.pollIntervalMinutes, policy.alertScanMinutes);
}

/**
 * Wrap an async job so overlapping ticks don't pile up: if a run is still in
 * flight when the next tick fires, the new call is skipped (resolves to
 * 'skipped'). Timer-free and DB-free, so it unit-tests directly.
 */
export function guarded<T>(fn: () => Promise<T>): () => Promise<T | 'skipped'> {
  let running = false;
  return async () => {
    if (running) return 'skipped';
    running = true;
    try {
      return await fn();
    } finally {
      running = false;
    }
  };
}

async function runReconcile(): Promise<void> {
  const res = await reconcile();
  // Leave a trail so a scheduled run is visible in the audit log like a manual
  // one. Best-effort: never let an audit-write error escape the timer.
  await pool
    .query(`INSERT INTO audit_log (actor, action, detail) VALUES ('system:scheduler','reconcile.scheduled',$1)`, [
      { checked: res.checked, corrected: res.corrected.length, alerts: res.alerts.length },
    ])
    .catch((e) => console.error('[scheduler] reconcile audit write failed:', e.message));
}

async function runPrune(): Promise<void> {
  // pruneConsentChecks already writes its own audit row.
  await pruneConsentChecks('system:scheduler');
  // Operational audit_log prune (compliance actions exempt; best-effort).
  await pruneAuditLog('system:scheduler').catch((e) => console.error('[scheduler] audit_log prune failed:', e.message));
  // Keep the webhook-dedup table bounded (best-effort; failure must not stop the job).
  await pruneWebhookEvents().catch((e) => console.error('[scheduler] webhook-dedup prune failed:', e.message));
}

async function runPoll(): Promise<void> {
  const summaries = await pollAll();
  const total = summaries.reduce((n, s) => n + s.ingested, 0);
  if (total > 0) console.log(`[scheduler] poll ingested ${total} event(s) across ${summaries.length} system(s)`);
}

async function runAlertScan(): Promise<void> {
  const alert = await scanSyncLag();
  if (alert) console.warn(`[scheduler] sync-lag alert: ${alert.breaches} breach(es), ${alert.warns} warning(s), worst ~${alert.worstLagHours}h`);
}

let timers: NodeJS.Timeout[] = [];

/**
 * Start the background jobs per config. Idempotent (clears any prior timers).
 * Returns a stop function. Timers are unref'd so they never block process exit.
 */
export function startScheduler(cfg: ScheduleConfig = currentSchedule()): () => void {
  stopScheduler();
  const log = (m: string) => console.log(`[scheduler] ${m}`);

  if (cfg.reconcileEveryMs > 0) {
    const job = guarded(runReconcile);
    timers.push(setInterval(() => {
      job().catch((e) => console.error('[scheduler] reconcile failed:', e.message));
    }, cfg.reconcileEveryMs));
    log(`reconciliation every ${Math.round(cfg.reconcileEveryMs / MINUTE)}m`);
  }
  if (cfg.pruneEveryMs > 0) {
    const job = guarded(runPrune);
    timers.push(setInterval(() => {
      job().catch((e) => console.error('[scheduler] prune failed:', e.message));
    }, cfg.pruneEveryMs));
    log(`consent-check audit prune every ${Math.round(cfg.pruneEveryMs / HOUR)}h`);
  }
  if (cfg.pollEveryMs > 0) {
    const job = guarded(runPoll);
    timers.push(setInterval(() => {
      job().catch((e) => console.error('[scheduler] poll failed:', e.message));
    }, cfg.pollEveryMs));
    log(`inbound poll every ${Math.round(cfg.pollEveryMs / MINUTE)}m`);
  }
  if (cfg.alertEveryMs > 0) {
    const job = guarded(runAlertScan);
    timers.push(setInterval(() => {
      job().catch((e) => console.error('[scheduler] alert scan failed:', e.message));
    }, cfg.alertEveryMs));
    log(`sync-lag alert scan every ${Math.round(cfg.alertEveryMs / MINUTE)}m`);
  }
  if (!timers.length) {
    log('no scheduled jobs — set RECONCILE_INTERVAL_MINUTES / PRUNE_INTERVAL_HOURS / POLL_INTERVAL_MINUTES to enable');
  }
  for (const t of timers) t.unref?.();
  return stopScheduler;
}

export function stopScheduler(): void {
  for (const t of timers) clearInterval(t);
  timers = [];
}
