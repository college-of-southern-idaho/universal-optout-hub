import { randomUUID } from 'node:crypto';
import { pool } from '../db.js';
import { policy } from '../core/policy.js';
import { log } from '../core/logger.js';
import { recomputeIdentity } from './projection.js';
import { getAdapter, allAdapters } from '../adapters/registry.js';
import type { Channel } from '../core/types.js';

/**
 * Opt-in propagation approval queue (DESIGN.md §11).
 * Coalescing key: (identity, channel). Local opt-ins are NEVER gated —
 * by the time a review exists, the originating system is already opted in.
 */

// ---- Pure decision rules (exported for testing without a database) ----------

/** Is a target pre-checked in the review? Same-channel systems only, per policy (§11.4). */
export function isPreselected(preselectSameChannel: boolean, systemChannel: string, reviewChannel: string): boolean {
  return preselectSameChannel && systemChannel === reviewChannel;
}

/** Separation of duties (§12): the operator who initiated the manual event cannot
 *  decide its own review when the policy is enabled. */
export function violatesSeparationOfDuties(
  initiatorCannotApprove: boolean,
  initiatedByUserId: number | null,
  decidedByUserId: number | null | undefined,
): boolean {
  return initiatorCannotApprove && decidedByUserId != null && initiatedByUserId != null
    && initiatedByUserId === decidedByUserId;
}

/** Precedence rule 1 (§7): never override an EXPLICIT opt-out, even if the
 *  reviewer selected that system — the write is skipped. */
export function skipsExplicitOptOut(state: string | undefined, provenance: string | undefined): boolean {
  return state === 'opted_out' && provenance === 'explicit';
}

/** An approval requires a non-empty attestation (§11.5). */
export function attestationMissing(outcome: 'approved' | 'denied', attestationText: string | undefined): boolean {
  return outcome === 'approved' && !attestationText?.trim();
}
export async function createOrCoalesceReview(
  identityId: number,
  channel: Channel,
  eventId: number,
  originSystemId: string,
  initiatedByUserId: number | null = null,
): Promise<unknown> {
  const pending = await pool.query(
    `SELECT id, version FROM approval_requests
      WHERE identity_id=$1 AND channel=$2 AND status='pending'`,
    [identityId, channel],
  );

  if (pending.rows[0]) {
    // Coalesce (§11.3): append event, refresh snapshot, bump version.
    const reqId = pending.rows[0].id;
    await pool.query(
      `INSERT INTO approval_request_events (request_id, event_id) VALUES ($1,$2)
       ON CONFLICT DO NOTHING`,
      [reqId, eventId],
    );
    const ttlClause = policy.ttlResetOnCoalesce
      ? `, expires_at = now() + interval '${policy.reviewTtlDays} days'`
      : '';
    await pool.query(
      `UPDATE approval_requests SET version = version + 1${ttlClause} WHERE id=$1`,
      [reqId],
    );
    await refreshTargetSnapshots(reqId, identityId);
    return { queued: true, coalesced_into: reqId };
  }

  const req = await pool.query(
    `INSERT INTO approval_requests (identity_id, channel, expires_at, initiated_by_user_id)
     VALUES ($1,$2, now() + interval '${policy.reviewTtlDays} days', $3) RETURNING id`,
    [identityId, channel, initiatedByUserId],
  );
  const reqId: number = req.rows[0].id;
  await pool.query(`INSERT INTO approval_request_events (request_id, event_id) VALUES ($1,$2)`, [
    reqId,
    eventId,
  ]);

  // Build the target list: every system except the origin, preselected per
  // policy (same-channel checked, cross-channel visible but unchecked — §11.4).
  for (const a of allAdapters()) {
    if (a.system.id === originSystemId) continue;
    const cur = await pool.query(
      `SELECT state, provenance FROM consent_states WHERE identity_id=$1 AND system_id=$2`,
      [identityId, a.system.id],
    );
    await pool.query(
      `INSERT INTO approval_targets
         (request_id, system_id, preselected, snapshot_state, snapshot_provenance)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        reqId,
        a.system.id,
        isPreselected(policy.preselectSameChannel, a.system.channel, channel),
        cur.rows[0]?.state ?? 'unknown',
        cur.rows[0]?.provenance ?? null,
      ],
    );
  }
  return { queued: true, request_id: reqId };
}

async function refreshTargetSnapshots(reqId: number, identityId: number): Promise<void> {
  const targets = await pool.query(`SELECT system_id FROM approval_targets WHERE request_id=$1`, [
    reqId,
  ]);
  for (const t of targets.rows) {
    const cur = await pool.query(
      `SELECT state, provenance FROM consent_states WHERE identity_id=$1 AND system_id=$2`,
      [identityId, t.system_id],
    );
    await pool.query(
      `UPDATE approval_targets SET snapshot_state=$3, snapshot_provenance=$4
        WHERE request_id=$1 AND system_id=$2`,
      [reqId, t.system_id, cur.rows[0]?.state ?? 'unknown', cur.rows[0]?.provenance ?? null],
    );
  }
}

/** Auto-cancel invariant (§11.6): opt-outs never wait on a queue. */
export async function cancelPendingForIdentity(identityId: number, reason: string): Promise<number> {
  const r = await pool.query(
    `UPDATE approval_requests
        SET status='canceled', decided_at=now(), decision_note=$2
      WHERE identity_id=$1 AND status='pending' RETURNING id`,
    [identityId, reason],
  );
  for (const row of r.rows) {
    await pool.query(`INSERT INTO audit_log (action, detail) VALUES ('review_auto_canceled',$1)`, [
      JSON.stringify({ request_id: row.id, reason }),
    ]);
  }
  return r.rowCount ?? 0;
}

/** Lazy TTL expiry (§11.8). Returns number of requests expired. */
export async function expireStale(): Promise<number> {
  const r = await pool.query(
    `UPDATE approval_requests SET status='expired', decided_at=now(),
            decision_note='TTL elapsed'
      WHERE status='pending' AND expires_at < now() RETURNING id`,
  );
  return r.rowCount ?? 0;
}

export interface Decision {
  requestId: number;
  version: number;              // optimistic concurrency (§11.8)
  outcome: 'approved' | 'denied';
  selectedTargets: string[];    // system ids; empty + approved = keep local
  attestationText: string;
  decidedBy: string;
  decidedByUserId?: number;     // authenticated approver
  note?: string;
}

export async function decide(d: Decision): Promise<unknown> {
  await expireStale();
  const req = await pool.query(`SELECT * FROM approval_requests WHERE id=$1`, [d.requestId]);
  const row = req.rows[0];
  if (!row) throw new Error('no such approval request');
  if (row.status !== 'pending') throw new Error(`request is ${row.status}, not pending`);
  if (row.version !== d.version) {
    const err: any = new Error(
      `stale decision: request is at version ${row.version}, decision was rendered from version ${d.version}`,
    );
    err.code = 'VERSION_CONFLICT';
    throw err;
  }
  if (attestationMissing(d.outcome, d.attestationText)) {
    throw new Error('approval requires an attestation (DESIGN.md §11.5)');
  }
  // Separation of duties (DESIGN.md §12): when enabled, the operator who
  // initiated the originating manual event cannot decide its review.
  if (violatesSeparationOfDuties(policy.initiatorCannotApprove, row.initiated_by_user_id, d.decidedByUserId)) {
    throw new Error('separation of duties: the initiating operator cannot approve this request');
  }

  const identityId: number = row.identity_id;
  const identity = await pool.query(`SELECT value_normalized FROM identities WHERE id=$1`, [
    identityId,
  ]);
  const identityValue: string = identity.rows[0].value_normalized;

  const written: { system: string; outcome: string }[] = [];

  if (d.outcome === 'approved') {
    for (const sysId of d.selectedTargets) {
      const adapter = getAdapter(sysId);
      // Precedence rule 1: never override an explicit opt-out — even if the
      // reviewer selected it. Record the skip; do not write.
      const cur = await pool.query(
        `SELECT state, provenance FROM consent_states WHERE identity_id=$1 AND system_id=$2`,
        [identityId, sysId],
      );
      if (skipsExplicitOptOut(cur.rows[0]?.state, cur.rows[0]?.provenance)) {
        await pool.query(
          `UPDATE approval_targets SET selected=true, outcome='skipped_explicit_optout'
            WHERE request_id=$1 AND system_id=$2`,
          [d.requestId, sysId],
        );
        written.push({ system: sysId, outcome: 'skipped_explicit_optout' });
        continue;
      }

      const key = randomUUID();
      const evIns = await pool.query(
        `INSERT INTO consent_events
           (identity_id, system_id, channel, direction, provenance, occurred_at,
            source_detail, sync_origin_key, approval_request_id, actor)
         VALUES ($1,$2,$3,'opt_in','derived',now(),$4,$5,$6,$7) RETURNING id`,
        [
          identityId,
          sysId,
          adapter.system.channel,
          `approved propagation (request ${d.requestId})`,
          key,
          d.requestId,
          d.decidedBy,
        ],
      );
      await pool.query(
        `INSERT INTO hub_writes (sync_origin_key, identity_id, system_id, direction)
         VALUES ($1,$2,$3,'opt_in')`,
        [key, identityId, sysId],
      );

      let outcome = 'written';
      if (!policy.enableOutboundWrites) {
        // Test mode: the opt-in is recorded internally (event + hub_write above)
        // but not pushed to the platform.
        log.info('outbound_write_suppressed', { system: sysId, identity: identityValue, direction: 'opt_in', reason: 'enableOutboundWrites=off (approval)' });
        outcome = 'write_suppressed_test_mode';
      } else if (!adapter.system.can_write_optin) {
        await pool.query(
          `INSERT INTO reconcile_alerts (identity_id, system_id, expected, observed, reason)
           VALUES ($1,$2,'opted_in',$3,'system does not accept hub opt-in writes')`,
          [identityId, sysId, await adapter.observe(identityValue)],
        );
        outcome = 'alert_unwritable';
      } else {
        const w = await adapter.write(identityValue, 'opt_in', key);
        if (w.ok && w.echo) {
          // Confirm the echo (same path ingest uses, inlined to avoid a cycle).
          await pool.query(
            `UPDATE hub_writes SET confirmed_at=now() WHERE sync_origin_key=$1`,
            [w.echo.sync_origin_key],
          );
        } else {
          outcome = `write_failed: ${w.reason}`;
        }
      }
      await pool.query(
        `UPDATE approval_targets SET selected=true, outcome=$3, result_event_id=$4
          WHERE request_id=$1 AND system_id=$2`,
        [d.requestId, sysId, outcome, evIns.rows[0].id],
      );
      written.push({ system: sysId, outcome });
    }
    await pool.query(
      `UPDATE approval_targets SET selected=false
        WHERE request_id=$1 AND selected IS NULL`,
      [d.requestId],
    );
  }

  await pool.query(
    `UPDATE approval_requests
        SET status=$2, decided_by=$3, decided_by_user_id=$6, decided_at=now(),
            attestation_text=$4, decision_note=$5
      WHERE id=$1`,
    [d.requestId, d.outcome, d.decidedBy, d.attestationText, d.note ?? null, d.decidedByUserId ?? null],
  );
  await pool.query(`INSERT INTO audit_log (actor, action, detail) VALUES ($1,'review_decided',$2)`, [
    d.decidedBy,
    JSON.stringify({ request_id: d.requestId, outcome: d.outcome, targets: written }),
  ]);

  await recomputeIdentity(identityId);
  return { request_id: d.requestId, outcome: d.outcome, targets: written };
}
