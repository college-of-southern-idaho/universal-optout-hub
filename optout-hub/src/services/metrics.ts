import { pool } from '../db.js';
import { syncLagReport } from './reporting.js';

/**
 * Operational metrics. A pull-model endpoint (`GET /metrics`) exposes
 * these in Prometheus text exposition format; the values are computed from the
 * database at scrape time rather than kept in in-process counters, so they are
 * correct across restarts and (for the DB-derived ones) across instances.
 *
 * Keep the set small and cheap — each is a single indexed aggregate. Anything
 * needing per-request histograms (consent-check p99) belongs in a real metrics
 * client and is out of scope here.
 */

export interface Metric {
  name: string;
  help: string;
  type: 'gauge' | 'counter';
  value: number;
  labels?: Record<string, string>;
}

/** Escape a HELP string: backslashes and newlines only (Prometheus rules). */
function escapeHelp(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

/** Escape a label value: backslash, double-quote, newline. */
function escapeLabel(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/**
 * Pure: render metrics in Prometheus text exposition format (v0.0.4). HELP/TYPE
 * are emitted once per metric name (on first sample), so labeled series with a
 * shared name group correctly. Output ends with a trailing newline.
 */
export function renderPrometheus(metrics: Metric[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const m of metrics) {
    if (!seen.has(m.name)) {
      seen.add(m.name);
      lines.push(`# HELP ${m.name} ${escapeHelp(m.help)}`);
      lines.push(`# TYPE ${m.name} ${m.type}`);
    }
    const labels = m.labels && Object.keys(m.labels).length
      ? '{' + Object.entries(m.labels).map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',') + '}'
      : '';
    lines.push(`${m.name}${labels} ${m.value}`);
  }
  return lines.join('\n') + '\n';
}

async function scalar(sql: string): Promise<number> {
  const r = await pool.query<{ n: string | number }>(sql);
  return Number(r.rows[0]?.n ?? 0);
}

/** Collect the current metric set from the database (single-scrape snapshot). */
export async function collectMetrics(): Promise<Metric[]> {
  const [
    identities, events, unconfirmed, alerts, pending, webhookEvents, checks, lag,
  ] = await Promise.all([
    scalar('SELECT COUNT(*)::int AS n FROM identities'),
    scalar('SELECT COUNT(*)::int AS n FROM consent_events'),
    scalar('SELECT COUNT(*)::int AS n FROM hub_writes WHERE confirmed_at IS NULL'),
    scalar('SELECT COUNT(*)::int AS n FROM reconcile_alerts WHERE resolved_at IS NULL'),
    scalar("SELECT COUNT(*)::int AS n FROM approval_requests WHERE status = 'pending'"),
    scalar('SELECT COUNT(*)::int AS n FROM webhook_events'),
    pool.query<{ decision: string; n: number }>(
      `SELECT decision, COUNT(*)::int AS n FROM consent_checks
        WHERE checked_at >= now() - interval '24 hours' GROUP BY decision`,
    ),
    syncLagReport(),
  ]);

  const lagging = lag.filter((r) => r.severity === 'warn' || r.severity === 'breach');
  const breaches = lagging.filter((r) => r.severity === 'breach').length;
  const worstSeconds = lagging.reduce((m, r) => Math.max(m, r.lag_seconds), 0);

  const metrics: Metric[] = [
    { name: 'consenthub_up', help: 'Always 1 if the metrics endpoint is serving.', type: 'gauge', value: 1 },
    { name: 'consenthub_identities_total', help: 'Distinct identities known to the hub.', type: 'gauge', value: identities },
    { name: 'consenthub_consent_events_total', help: 'Consent events recorded (all time).', type: 'gauge', value: events },
    { name: 'consenthub_hub_writes_unconfirmed', help: 'Outbound propagations issued but not yet confirmed converged.', type: 'gauge', value: unconfirmed },
    { name: 'consenthub_reconcile_alerts_unresolved', help: 'Open reconciliation alerts (drift detected, not yet resolved).', type: 'gauge', value: alerts },
    { name: 'consenthub_reviews_pending', help: 'Opt-in propagation reviews awaiting a decision.', type: 'gauge', value: pending },
    { name: 'consenthub_webhook_events_total', help: 'Deduplicated inbound webhook events seen (replay table size).', type: 'gauge', value: webhookEvents },
    { name: 'consenthub_sync_lag_lagging', help: 'Opt-out propagations past the warn threshold (warn + breach).', type: 'gauge', value: lagging.length },
    { name: 'consenthub_sync_lag_breaches', help: 'Opt-out propagations past the 10-business-day regulatory ceiling.', type: 'gauge', value: breaches },
    { name: 'consenthub_sync_lag_worst_seconds', help: 'Largest current sync-lag across lagging propagations, in seconds.', type: 'gauge', value: worstSeconds },
  ];

  // One labeled series per decision seen in the last 24h; always emit the three
  // known decisions (0 when absent) so a rate() has a continuous series.
  const byDecision = new Map(checks.rows.map((r) => [r.decision, Number(r.n)]));
  for (const decision of ['allow', 'suppress', 'error']) {
    metrics.push({
      name: 'consenthub_consent_checks_recent',
      help: 'Consent-check decisions in the last 24 hours, by outcome.',
      type: 'gauge',
      value: byDecision.get(decision) ?? 0,
      labels: { decision },
    });
  }

  return metrics;
}
