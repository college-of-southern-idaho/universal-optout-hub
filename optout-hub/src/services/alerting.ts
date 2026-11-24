import { pool } from '../db.js';
import { readSecret } from '../core/config.js';
import { syncLagReport, type SyncLagRow } from './reporting.js';

/**
 * Sync-lag alerting (DESIGN §8.4). An opt-out that hasn't converged on a target
 * system within the configured threshold is a compliance risk, so the hub scans
 * for lagging propagations on a timer (scheduler, `alertScanMinutes`) and raises
 * an alert. Delivery is deployment-agnostic: every alert is written to the audit
 * log, and if `ALERT_WEBHOOK_URL` is set (e.g. a Slack/Teams/PagerDuty incoming
 * webhook) the summary is POSTed there too. A manual scan is also available at
 * POST /api/alerts/scan.
 */

export interface SyncLagAlert {
  breaches: number;   // over the 10-business-day regulatory ceiling
  warns: number;      // over the warn threshold but under the ceiling
  worstLagHours: number;
  examples: { identity: string; target_system: string; lag_hours: number; severity: string }[];
}

/**
 * Pure: reduce sync-lag rows to an alert summary, considering only rows that are
 * still lagging (severity warn/breach). Returns null when nothing is lagging.
 */
export function summarizeSyncLag(rows: SyncLagRow[]): SyncLagAlert | null {
  const lagging = rows.filter((r) => r.severity === 'warn' || r.severity === 'breach');
  if (!lagging.length) return null;
  const breaches = lagging.filter((r) => r.severity === 'breach').length;
  const warns = lagging.length - breaches;
  const worstSeconds = lagging.reduce((m, r) => Math.max(m, r.lag_seconds), 0);
  const worstLagHours = Math.round(worstSeconds / 3600);
  const examples = lagging.slice(0, 5).map((r) => ({
    identity: r.value_normalized,
    target_system: r.target_system,
    lag_hours: Math.round(r.lag_seconds / 3600),
    severity: r.severity,
  }));
  return { breaches, warns, worstLagHours, examples };
}

/** Write the alert to the audit log and, if configured, POST it to a webhook. */
export async function dispatchSyncLagAlert(alert: SyncLagAlert): Promise<void> {
  await pool
    .query(`INSERT INTO audit_log (actor, action, detail) VALUES ('system:alerting','alert.sync_lag',$1)`, [alert])
    .catch((e) => console.error('[alerting] audit write failed:', e.message));

  const url = readSecret('ALERT_WEBHOOK_URL');
  if (!url) return;
  try {
    const text =
      `Consent hub sync-lag alert: ${alert.breaches} breach(es), ${alert.warns} warning(s); ` +
      `worst lag ~${alert.worstLagHours}h. Opt-outs are not converging within the threshold.`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // `text` is the Slack/Teams convention; `alert` carries the structured detail.
        body: JSON.stringify({ text, alert }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (e: any) {
    console.error('[alerting] webhook POST failed:', e.message);
  }
}

/**
 * Run one sync-lag scan: report → summarize → dispatch if anything is lagging.
 * Returns the alert (or null if all clear). Used by the scheduler and the
 * manual scan route.
 */
export async function scanSyncLag(): Promise<SyncLagAlert | null> {
  const alert = summarizeSyncLag(await syncLagReport());
  if (alert) await dispatchSyncLagAlert(alert);
  return alert;
}
