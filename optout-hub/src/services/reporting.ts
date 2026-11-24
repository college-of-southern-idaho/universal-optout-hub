import { pool } from '../db.js';
import { normalizeIdentity } from '../core/normalize.js';
import { policy } from '../core/policy.js';

/**
 * Reporting module (DESIGN.md §12, §14). Read-only queries over the existing
 * append-only log and projections — no writes, no consent logic. The
 * per-identity packet is the §227(c)(5) "reasonable practices and procedures"
 * affirmative-defense artifact in concrete, producible form.
 */

// ---- Pure, DB-free helpers (unit-tested in test/reporting.test.ts) ----------

/**
 * Whole business days (Mon–Fri) elapsed between two instants. Used to measure
 * opt-out honoring against the FCC 10-business-day ceiling (DESIGN.md §2.2, §8.4).
 * Counts weekday boundaries crossed: Mon→Tue = 1, Fri→Mon = 1, Mon→next Mon = 5.
 */
export function businessDaysBetween(start: Date, end: Date): number {
  if (!(end > start)) return 0;
  let count = 0;
  const cur = new Date(start.getTime());
  cur.setHours(0, 0, 0, 0);
  const last = new Date(end.getTime());
  last.setHours(0, 0, 0, 0);
  while (cur < last) {
    cur.setDate(cur.getDate() + 1);
    const day = cur.getDay();
    if (day !== 0 && day !== 6) count++;
  }
  return count;
}

export type LagSeverity = 'ok' | 'warn' | 'breach';

/**
 * Classify an opt-out propagation's convergence lag.
 *  - `breach`: exceeded the regulatory ceiling (default 10 business days) — a
 *    real compliance failure.
 *  - `warn`:   within the ceiling but over the org's tight operational target
 *    (`syncLagAlertHours`) — the system is slower than intended.
 *  - `ok`:     within target.
 */
export function lagSeverity(
  lagMs: number,
  warnThresholdMs: number,
  businessDays: number,
  regulatoryBusinessDays = 10,
): LagSeverity {
  if (businessDays > regulatoryBusinessDays) return 'breach';
  if (lagMs > warnThresholdMs) return 'warn';
  return 'ok';
}

function csvField(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Flatten an identity packet's event history into CSV — the chronological
 * event log is the most litigation-relevant view. Pure: takes the packet,
 * returns the CSV text.
 */
export function packetToCsv(packet: IdentityPacket): string {
  const cols = [
    'occurred_at', 'received_at', 'system_id', 'channel', 'direction',
    'provenance', 'source_detail', 'evidence_method', 'consent_language',
    'actor', 'sync_origin_key',
  ] as const;
  const rows = [cols.join(',')];
  for (const e of packet.events) {
    rows.push(cols.map((c) => csvField((e as Record<string, unknown>)[c])).join(','));
  }
  return rows.join('\r\n');
}

// ---- Types ------------------------------------------------------------------

export interface IdentityPacket {
  identity: {
    id: number; kind: string; value_normalized: string; value_raw: string; created_at: Date;
  };
  reachability: {
    currently_reachable: string[];     // systems where state = opted_in
    suppressed_or_opted_out: string[]; // systems where state = opted_out | suppressed
    summary: string;
  };
  states: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  approvals: Array<Record<string, unknown>>;
  alerts: Array<Record<string, unknown>>;
}

interface DateRange { from?: Date | null; to?: Date | null; }

// ---- Identity lookup / discovery packet -------------------------------------

/**
 * Look up one phone/email and assemble its complete record. The query value is
 * normalized with the SAME normalizer used at ingest (DESIGN.md §4), so a match
 * succeeds regardless of input formatting. Returns null if the value cannot be
 * normalized or no such identity exists.
 */
export async function lookupIdentity(rawValue: string): Promise<IdentityPacket | null> {
  const norm = normalizeIdentity(rawValue);
  if (!norm) return null;

  const idRow = await pool.query(
    `SELECT id, kind, value_normalized, value_raw, created_at
       FROM identities WHERE value_normalized = $1`,
    [norm.normalized],
  );
  if (!idRow.rows[0]) return null;
  const identity = idRow.rows[0];
  const id: number = identity.id;

  const [states, events, approvals, alerts] = await Promise.all([
    pool.query(
      `SELECT cs.system_id, s.name AS system_name, s.channel,
              cs.state, cs.provenance, cs.as_of_event, cs.updated_at
         FROM consent_states cs JOIN systems s ON s.id = cs.system_id
        WHERE cs.identity_id = $1 ORDER BY cs.system_id`,
      [id],
    ),
    pool.query(
      `SELECT e.id, e.system_id, e.channel, e.direction, e.provenance,
              e.occurred_at, e.received_at, e.source_detail, e.sync_origin_key,
              e.approval_request_id,
              COALESCE(u.username, e.actor, 'System') AS actor,   -- 'System' for automated events
              ev.method AS evidence_method,
              ev.consent_language, u.username AS actor_username
         FROM consent_events e
         LEFT JOIN evidence ev ON ev.id = e.evidence_id
         LEFT JOIN users u ON u.id = e.actor_user_id
        WHERE e.identity_id = $1
        ORDER BY e.occurred_at, e.id`,
      [id],
    ),
    pool.query(
      `SELECT ar.id, ar.channel, ar.status, ar.version, ar.created_at, ar.expires_at,
              ar.decided_by, ar.decided_at, ar.attestation_text, ar.decision_note,
              iu.username AS initiated_by_username, du.username AS decided_by_username
         FROM approval_requests ar
         LEFT JOIN users iu ON iu.id = ar.initiated_by_user_id
         LEFT JOIN users du ON du.id = ar.decided_by_user_id
        WHERE ar.identity_id = $1 ORDER BY ar.created_at DESC`,
      [id],
    ),
    pool.query(
      `SELECT id, system_id, expected, observed, reason, created_at, resolved_at
         FROM reconcile_alerts WHERE identity_id = $1 ORDER BY created_at DESC`,
      [id],
    ),
  ]);

  const reachable = states.rows.filter((r) => r.state === 'opted_in').map((r) => r.system_id);
  const blocked = states.rows
    .filter((r) => r.state === 'opted_out' || r.state === 'suppressed')
    .map((r) => r.system_id);
  const summary = reachable.length === 0
    ? 'Not reachable on any system.'
    : `Reachable on ${reachable.length} system(s); suppressed/opted out on ${blocked.length}.`;

  return {
    identity,
    reachability: { currently_reachable: reachable, suppressed_or_opted_out: blocked, summary },
    states: states.rows,
    events: events.rows,
    approvals: approvals.rows,
    alerts: alerts.rows,
  };
}

// ---- User-action audit search (DESIGN.md §14) -------------------------------

export interface AuditSearch extends DateRange {
  actor?: string | null;   // matches the session username OR a legacy free-text actor
  action?: string | null;
  limit?: number;
}

/**
 * SQL for the display label of who performed an action: the linked user's
 * username, or **System** for an automated/scheduled action (audit_log.actor is
 * NULL, or a `system:*` label from the scheduler/alerting). A legacy free-text
 * actor is shown as-is. Requires the aliases `audit_log AS a`, `users AS u`.
 * Exported so `/api/audit` renders identically.
 */
export const AUDIT_ACTOR_LABEL =
  "COALESCE(u.username, CASE WHEN a.actor LIKE 'system:%' THEN 'System' ELSE a.actor END, 'System')";

export async function searchAudit(q: AuditSearch): Promise<Array<Record<string, unknown>>> {
  const limit = Math.min(Math.max(q.limit ?? 200, 1), 1000);
  const r = await pool.query(
    `SELECT a.id, a.at, a.action, a.detail, a.actor, a.actor_user_id,
            u.username AS actor_username,
            ${AUDIT_ACTOR_LABEL} AS actor_label
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.actor_user_id
      WHERE ($1::text IS NULL OR ${AUDIT_ACTOR_LABEL} = $1)
        AND ($2::text IS NULL OR a.action = $2)
        AND ($3::timestamptz IS NULL OR a.at >= $3)
        AND ($4::timestamptz IS NULL OR a.at <= $4)
      ORDER BY a.id DESC
      LIMIT $5`,
    [q.actor ?? null, q.action ?? null, q.from ?? null, q.to ?? null, limit],
  );
  return r.rows;
}

/** Distinct values to populate the audit-search filter dropdowns. */
export async function auditFacets(): Promise<{ actions: string[]; actors: string[] }> {
  const [actions, actors] = await Promise.all([
    pool.query(`SELECT DISTINCT action FROM audit_log ORDER BY action`),
    pool.query(
      `SELECT DISTINCT ${AUDIT_ACTOR_LABEL} AS actor
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
        ORDER BY actor`,
    ),
  ]);
  return {
    actions: actions.rows.map((r) => r.action),
    actors: actors.rows.map((r) => r.actor),
  };
}

// ---- Opt-out sync-lag report (DESIGN.md §8.4) -------------------------------

export interface SyncLagRow {
  target_system: string;
  value_normalized: string;
  origin_system: string;
  optout_occurred_at: Date;
  issued_at: Date;
  confirmed_at: Date | null;
  lag_seconds: number;
  business_days: number;
  converged: boolean;
  severity: LagSeverity;
}

/**
 * For each hub-issued opt-out propagation, measure the interval from the
 * originating explicit opt-out's occurred_at to confirmed convergence on the
 * target system (DESIGN.md §8.4). Unconfirmed writes are measured against now,
 * so a propagation that never converged still surfaces as growing lag.
 */
export async function syncLagReport(range: DateRange = {}): Promise<SyncLagRow[]> {
  const warnMs = policy.syncLagAlertHours * 3600 * 1000;
  const r = await pool.query(
    `SELECT hw.system_id AS target_system, i.value_normalized,
            origin.system_id AS origin_system, origin.occurred_at AS optout_occurred_at,
            hw.issued_at, hw.confirmed_at,
            EXTRACT(EPOCH FROM (COALESCE(hw.confirmed_at, now()) - origin.occurred_at)) AS lag_seconds,
            (hw.confirmed_at IS NOT NULL) AS converged
       FROM hub_writes hw
       JOIN identities i ON i.id = hw.identity_id
       JOIN LATERAL (
         SELECT ce.occurred_at, ce.system_id
           FROM consent_events ce
          WHERE ce.identity_id = hw.identity_id
            AND ce.direction = 'opt_out' AND ce.provenance = 'explicit'
            AND ce.occurred_at <= hw.issued_at
          ORDER BY ce.occurred_at DESC LIMIT 1
       ) origin ON true
      WHERE hw.direction = 'opt_out'
        AND ($1::timestamptz IS NULL OR origin.occurred_at >= $1)
        AND ($2::timestamptz IS NULL OR origin.occurred_at <= $2)
      ORDER BY lag_seconds DESC`,
    [range.from ?? null, range.to ?? null],
  );
  return r.rows.map((row) => {
    const lagMs = Number(row.lag_seconds) * 1000;
    const end = row.confirmed_at ?? new Date();
    const businessDays = businessDaysBetween(new Date(row.optout_occurred_at), new Date(end));
    return {
      target_system: row.target_system,
      value_normalized: row.value_normalized,
      origin_system: row.origin_system,
      optout_occurred_at: row.optout_occurred_at,
      issued_at: row.issued_at,
      confirmed_at: row.confirmed_at,
      lag_seconds: Number(row.lag_seconds),
      business_days: businessDays,
      converged: row.converged,
      severity: lagSeverity(lagMs, warnMs, businessDays),
    };
  });
}

// ---- Open-liability / exceptions report (DESIGN.md §2.4) --------------------

export async function openLiabilityReport(): Promise<{
  unresolved_alerts: Array<Record<string, unknown>>;
  unconfirmed_writes: Array<Record<string, unknown>>;
  aging_reviews: Array<Record<string, unknown>>;
}> {
  const [alerts, writes, reviews] = await Promise.all([
    pool.query(
      `SELECT ra.id, ra.system_id, ra.expected, ra.observed, ra.reason,
              ra.created_at, i.value_normalized
         FROM reconcile_alerts ra JOIN identities i ON i.id = ra.identity_id
        WHERE ra.resolved_at IS NULL ORDER BY ra.created_at`,
    ),
    pool.query(
      `SELECT hw.sync_origin_key, hw.system_id, hw.direction, hw.issued_at,
              i.value_normalized,
              EXTRACT(EPOCH FROM (now() - hw.issued_at)) AS outstanding_seconds
         FROM hub_writes hw JOIN identities i ON i.id = hw.identity_id
        WHERE hw.confirmed_at IS NULL ORDER BY hw.issued_at`,
    ),
    pool.query(
      `SELECT ar.id, ar.channel, ar.created_at, ar.expires_at, i.value_normalized,
              EXTRACT(EPOCH FROM (ar.expires_at - now())) AS seconds_to_expiry
         FROM approval_requests ar JOIN identities i ON i.id = ar.identity_id
        WHERE ar.status = 'pending' ORDER BY ar.expires_at`,
    ),
  ]);
  return {
    unresolved_alerts: alerts.rows,
    unconfirmed_writes: writes.rows,
    aging_reviews: reviews.rows,
  };
}

// ---- Activity / volume summary (DESIGN.md §14 recordkeeping) ----------------

export async function activitySummary(range: DateRange = {}): Promise<Array<Record<string, unknown>>> {
  const r = await pool.query(
    `SELECT system_id, channel, direction, provenance, COUNT(*)::int AS count
       FROM consent_events
      WHERE ($1::timestamptz IS NULL OR occurred_at >= $1)
        AND ($2::timestamptz IS NULL OR occurred_at <= $2)
      GROUP BY system_id, channel, direction, provenance
      ORDER BY system_id, channel, direction, provenance`,
    [range.from ?? null, range.to ?? null],
  );
  return r.rows;
}

// ---- Per-system inbound status ----------------

export interface InboundStatusRow {
  id: string;
  name: string;
  adapter_type: string;
  last_inbound_at: Date | null;
  last_polled_at: Date | null;
  inbound_30d: number;
}

export type DeliveryMode = 'poll' | 'webhook' | 'none';

/** Adapter types that receive inbound consent via a signed webhook. */
export const WEBHOOK_ADAPTER_TYPES: ReadonlySet<string> = new Set(['twilio', 'sendgrid', 'telesign']);

/**
 * Pure: how a system receives inbound consent. Poll-delivery (a live adapter
 * implementing pollOptOuts) wins; otherwise a known webhook adapter type; else
 * none (outbound- or reconciliation-only).
 */
export function deliveryMode(isPollable: boolean, adapterType: string): DeliveryMode {
  if (isPollable) return 'poll';
  if (WEBHOOK_ADAPTER_TYPES.has(adapterType)) return 'webhook';
  return 'none';
}

/**
 * For each active system, when we last received a platform-originated inbound
 * event (webhook or poll), when we last polled it, and how many inbound events
 * landed in the last 30 days. "Inbound" = explicit, not hub-originated
 * (sync_origin_key IS NULL) and not a manual operator entry (actor IS NULL) —
 * i.e. genuinely from the platform. Poll timestamps come from poll_state.
 */
export async function inboundStatus(): Promise<InboundStatusRow[]> {
  const r = await pool.query<InboundStatusRow>(
    `SELECT s.id, s.name, s.adapter_type,
            ce.last_inbound_at,
            ps.last_polled_at,
            COALESCE(ce.inbound_30d, 0)::int AS inbound_30d
       FROM systems s
       LEFT JOIN poll_state ps ON ps.system_id = s.id
       LEFT JOIN (
         SELECT system_id,
                MAX(received_at) AS last_inbound_at,
                COUNT(*) FILTER (WHERE received_at >= now() - interval '30 days') AS inbound_30d
           FROM consent_events
          WHERE sync_origin_key IS NULL AND actor IS NULL AND provenance = 'explicit'
          GROUP BY system_id
       ) ce ON ce.system_id = s.id
      WHERE s.archived_at IS NULL
      ORDER BY s.name`,
  );
  return r.rows;
}

// ---- Topology attribution (ADR-0002 §4) -------------------------------------

/**
 * Attribute event volume to the department/pool that received it, joining
 * inbound events through their receiving code to discovered topology — and,
 * where present, the manual annotation. Reporting ONLY: this read never feeds
 * a consent decision (ADR-0002 §2.2). Both the discovered grouping and a
 * manual annotation are shown side by side; neither overrides the other.
 */
export async function topologyAttributionReport(
  range: DateRange = {},
): Promise<Array<Record<string, unknown>>> {
  const r = await pool.query(
    `SELECT ce.system_id,
            ce.receiving_code,
            code.label              AS code_label,
            pool.external_ref       AS pool_ref,
            pool.label              AS discovered_pool,
            ann.label               AS manual_group,
            COUNT(*)::int           AS events
       FROM consent_events ce
       LEFT JOIN topology_nodes code
         ON code.system_id = ce.system_id AND code.kind = 'code'
        AND code.external_ref = ce.receiving_code
       LEFT JOIN topology_nodes pool
         ON pool.system_id = ce.system_id AND pool.external_ref = code.parent_ref
       LEFT JOIN code_annotations ann
         ON ann.system_id = ce.system_id AND ann.code_ref = ce.receiving_code
      WHERE ce.receiving_code IS NOT NULL
        AND ($1::timestamptz IS NULL OR ce.occurred_at >= $1)
        AND ($2::timestamptz IS NULL OR ce.occurred_at <= $2)
      GROUP BY ce.system_id, ce.receiving_code, code.label,
               pool.external_ref, pool.label, ann.label
      ORDER BY ce.system_id, discovered_pool NULLS LAST, ce.receiving_code`,
    [range.from ?? null, range.to ?? null],
  );
  return r.rows;
}
