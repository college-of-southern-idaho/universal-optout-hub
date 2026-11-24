import { randomUUID } from 'node:crypto';
import { pool } from '../db.js';
import { normalizeIdentity } from '../core/normalize.js';
import { policy } from '../core/policy.js';
import { log } from '../core/logger.js';
import { recomputeIdentity } from './projection.js';
import { createOrCoalesceReview, cancelPendingForIdentity } from './approvals.js';
import { getAdapter, allAdapters } from '../adapters/registry.js';
import { cascades, isProtectedCategory } from './categories.js';
import type { Channel, Direction } from '../core/types.js';

export interface IncomingPlatformEvent {
  system_id: string;
  identity_value: string;       // raw, as the platform reports it
  direction: Direction;
  occurred_at?: Date;           // platform timestamp; defaults to now
  source_detail?: string;
  sync_origin_key?: string;     // present on echoes of hub-originated writes
  evidence?: { method: string; consent_language?: string };
  actor?: string;               // for operator-initiated manual events
  actor_user_id?: number;       // authenticated user id when entered via the console
  receiving_code?: string;      // attribution only (ADR-0002 §4); never read by consent logic
}

export async function resolveIdentity(raw: string): Promise<{ id: number; normalized: string }> {
  const norm = normalizeIdentity(raw);
  if (!norm) throw new Error(`could not normalize identity: ${raw}`);
  const existing = await pool.query(
    'SELECT id, value_normalized FROM identities WHERE value_normalized=$1',
    [norm.normalized],
  );
  if (existing.rows[0]) return { id: existing.rows[0].id, normalized: norm.normalized };
  const ins = await pool.query(
    'INSERT INTO identities (kind, value_normalized, value_raw) VALUES ($1,$2,$3) RETURNING id',
    [norm.kind, norm.normalized, norm.raw],
  );
  return { id: ins.rows[0].id, normalized: norm.normalized };
}

async function audit(actor: string | null, action: string, detail: unknown): Promise<void> {
  await pool.query('INSERT INTO audit_log (actor, action, detail) VALUES ($1,$2,$3)', [
    actor,
    action,
    JSON.stringify(detail),
  ]);
}

/**
 * Main ingestion path (DESIGN.md §8). Every platform event — consumer
 * actions, batch imports, and echoes of the hub's own writes — enters here.
 */
export async function ingest(ev: IncomingPlatformEvent): Promise<{ kind: string; detail?: unknown }> {
  const sys = getAdapter(ev.system_id).system;
  const identity = await resolveIdentity(ev.identity_value);
  const occurredAt = ev.occurred_at ?? new Date();

  // --- Echo suppression (§8.2) -------------------------------------------
  // An inbound event bearing one of OUR sync_origin_keys is, by definition, an
  // echo of a hub-originated write (the key is an opaque UUID we generate; a
  // consumer can only send it back by replaying our write). Match regardless of
  // confirmed_at so redelivered webhooks (delivery is at-least-once) are always
  // recognized as echoes — never re-recorded as a fresh consumer opt-out, which
  // would corrupt the target's provenance from 'derived' to explicit and loop.
  if (ev.sync_origin_key) {
    const hw = await pool.query(
      `SELECT confirmed_at FROM hub_writes
        WHERE sync_origin_key=$1 AND system_id=$2 AND direction=$3`,
      [ev.sync_origin_key, ev.system_id, ev.direction],
    );
    if (hw.rows[0]) {
      // Confirm convergence on first arrival; later redeliveries are idempotent.
      if (hw.rows[0].confirmed_at === null) {
        await pool.query(
          `UPDATE hub_writes SET confirmed_at=now()
            WHERE sync_origin_key=$1 AND system_id=$2 AND direction=$3`,
          [ev.sync_origin_key, ev.system_id, ev.direction],
        );
      }
      await audit(null, 'echo_confirmed', {
        system: ev.system_id,
        identity: identity.normalized,
        direction: ev.direction,
        key: ev.sync_origin_key,
      });
      return { kind: 'echo_confirmed' };
    }
    // Unknown key: fall through and treat as a genuine platform event,
    // but note it — this would indicate a bug or a spoofed webhook.
    await audit(null, 'unknown_sync_key', { key: ev.sync_origin_key, system: ev.system_id });
  }

  // --- Record the explicit event ------------------------------------------
  const evidenceId = ev.evidence
    ? (
        await pool.query(
          `INSERT INTO evidence (identity_id, channel, method, consent_language)
           VALUES ($1,$2,$3,$4) RETURNING id`,
          [identity.id, sys.channel, ev.evidence.method, ev.evidence.consent_language ?? null],
        )
      ).rows[0].id
    : null;

  if (ev.direction === 'opt_in' && !evidenceId) {
    throw new Error('explicit opt-in requires consent evidence (DESIGN.md §5.3)');
  }

  const inserted = await pool.query(
    `INSERT INTO consent_events
       (identity_id, system_id, channel, direction, provenance, occurred_at,
        source_detail, evidence_id, actor, actor_user_id, receiving_code)
     VALUES ($1,$2,$3,$4,'explicit',$5,$6,$7,$8,$9,$10) RETURNING id`,
    [
      identity.id,
      ev.system_id,
      sys.channel,
      ev.direction,
      occurredAt,
      ev.source_detail ?? null,
      evidenceId,
      ev.actor ?? null,
      ev.actor_user_id ?? null,
      ev.receiving_code ?? null,   // stored for reporting attribution only (ADR-0002 §4)
    ],
  );
  const eventId: number = inserted.rows[0].id;
  await audit(ev.actor ?? null, 'event_ingested', {
    event_id: eventId,
    system: ev.system_id,
    identity: identity.normalized,
    direction: ev.direction,
    occurred_at: occurredAt,
    source: ev.source_detail,
  });

  await recomputeIdentity(identity.id);

  // --- Direction-specific behavior ----------------------------------------
  if (ev.direction === 'opt_out') {
    // Auto-cancel invariant (§11.6): any opt-out cancels pending reviews.
    await cancelPendingForIdentity(identity.id, `opt-out received on ${ev.system_id}`);
    // Immediate, automatic propagation (§10).
    const propagated = await propagateOptOut(identity.id, identity.normalized, ev.system_id);
    return { kind: 'opt_out_ingested', detail: { event_id: eventId, propagated } };
  }

  // Explicit opt-in: always honored locally (§11.1). Review trigger check (§11.2):
  const review = await maybeQueueReview(identity.id, sys.channel as Channel, eventId, ev.system_id, ev.actor_user_id ?? null);
  return { kind: 'opt_in_ingested', detail: { event_id: eventId, review } };
}

/**
 * Opt-out fan-out (§10): derived suppression to other systems, governed by the
 * message-category cascade matrix. The opt-out's source category is the origin
 * system's category; a target is suppressed only if the matrix says the source
 * category cascades to the target's category — and never if the target category
 * is protected (emergency/safety). Cross-category over-suppression is exactly
 * what this prevents (a marketing STOP no longer silences transactional mail).
 */
async function propagateOptOut(
  identityId: number,
  identityValue: string,
  originSystemId: string,
): Promise<{ system: string; result: string }[]> {
  const results: { system: string; result: string }[] = [];
  const origin = await originContext(originSystemId);
  for (const adapter of allAdapters()) {
    const sysId = adapter.system.id;
    if (sysId === originSystemId) continue;
    // Consent is channel-scoped: a phone opt-out never cascades onto an email
    // service (or vice versa) — different identifier, different consent. This
    // also keeps the email-to-SMS gateway within SMS (its own channel).
    if (adapter.system.channel !== origin.channel) continue;
    const targetCat = adapter.system.category;
    if (!cascades(origin.category, targetCat)) continue;   // matrix says no, or target is protected
    results.push(await deriveSuppression(
      identityId, identityValue, sysId,
      `propagated from ${originSystemId} (${origin.channel}/${origin.category}→${targetCat})`,
    ));
  }
  await recomputeIdentity(identityId);
  return results;
}

/** The category + channel of a system id, read from the systems table (works
 *  even if the origin system was archived after the event was recorded).
 *  Defaults match the column defaults if the row is somehow missing. */
async function originContext(systemId: string): Promise<{ category: string; channel: string }> {
  const r = await pool.query<{ category: string; channel: string }>(
    'SELECT category, channel FROM systems WHERE id=$1', [systemId],
  );
  return { category: r.rows[0]?.category ?? 'marketing', channel: r.rows[0]?.channel ?? 'sms' };
}

/**
 * Record and (where possible) write a single derived suppression for one system.
 * Shared by the immediate opt-out fan-out and the reconciler's backfill pass, so
 * a service that is added AFTER an opt-out gets suppressed the same way one that
 * existed at opt-out time does. Idempotent in effect: a system already carrying
 * an explicit consumer opt-out is left untouched. Does not recompute the
 * projection — the caller batches recomputeIdentity once it has finished.
 */
export async function deriveSuppression(
  identityId: number,
  identityValue: string,
  sysId: string,
  reason: string,
): Promise<{ system: string; result: string }> {
  const adapter = getAdapter(sysId);

  // Hard guarantee: a protected category (emergency/safety) is NEVER suppressed,
  // regardless of the matrix or how we were reached (DESIGN.md §10; the TCPA
  // emergency-purposes exception, 47 C.F.R. 64.1200(f)(4)).
  if (isProtectedCategory(adapter.system.category)) {
    return { system: sysId, result: 'skipped_protected' };
  }

  // The consumer's own explicit opt-out stands; nothing to derive.
  const cur = await pool.query(
    `SELECT state, provenance FROM consent_states WHERE identity_id=$1 AND system_id=$2`,
    [identityId, sysId],
  );
  if (cur.rows[0]?.state === 'opted_out' && cur.rows[0]?.provenance === 'explicit') {
    return { system: sysId, result: 'already_explicit_optout' };
  }

  const key = randomUUID();
  await pool.query(
    `INSERT INTO consent_events
       (identity_id, system_id, channel, direction, provenance, occurred_at, source_detail, sync_origin_key)
     VALUES ($1,$2,$3,'opt_out','derived',now(),$4,$5)`,
    [identityId, sysId, adapter.system.channel, reason, key],
  );

  // Master safety switch — test mode (enableOutboundWrites=off): the derived
  // suppression is recorded internally (above) but nothing is pushed to the
  // platform — no hub_write, no adapter.write, no unwritable alert. The projection
  // still marks the target suppressed; a later production run + reconcile flushes.
  if (!policy.enableOutboundWrites) {
    log.info('outbound_write_suppressed', { system: sysId, identity: identityValue, direction: 'opt_out', reason: 'enableOutboundWrites=off' });
    return { system: sysId, result: 'write_suppressed_test_mode' };
  }

  await pool.query(
    `INSERT INTO hub_writes (sync_origin_key, identity_id, system_id, direction) VALUES ($1,$2,$3,'opt_out')`,
    [key, identityId, sysId],
  );

  if (!adapter.system.can_write_optout) {
    // Unwritable divergence (§8.3): the hub's record stands and enforcement is
    // by withholding sends; surface it rather than retrying.
    await pool.query(
      `INSERT INTO reconcile_alerts (identity_id, system_id, expected, observed, reason)
       VALUES ($1,$2,'opted_out',$3,'system does not accept hub opt-out writes')`,
      [identityId, sysId, await adapter.observe(identityValue)],
    );
    return { system: sysId, result: 'alert_unwritable' };
  }

  const w = await adapter.write(identityValue, 'opt_out', key);
  if (!w.ok) return { system: sysId, result: `write_failed: ${w.reason}` };
  if (w.echo) {
    await ingest({
      system_id: w.echo.system_id,
      identity_value: w.echo.identity_value,
      direction: w.echo.direction,
      occurred_at: w.echo.occurred_at,
      sync_origin_key: w.echo.sync_origin_key,
      source_detail: 'platform webhook (echo)',
    });
    return { system: sysId, result: 'written_and_confirmed' };
  }
  // Accepted by a live platform that confirms asynchronously via webhook later.
  return { system: sysId, result: 'written' };
}

/**
 * Pure: given the review-trigger policy and the consent states an identity holds
 * on OTHER systems, should an opt-in queue a propagation review? (§11.2)
 *   - never                    → never queue.
 *   - any_state_elsewhere      → queue if the identity is known on any other system.
 *   - explicit_optout_elsewhere→ queue only if some other system carries an explicit
 *                                opt-out or a propagated suppression.
 * Exported for testing without a database.
 */
export function shouldQueueReview(
  trigger: 'explicit_optout_elsewhere' | 'any_state_elsewhere' | 'never',
  otherStates: Array<{ state: string; provenance: string | null }>,
): boolean {
  if (trigger === 'never') return false;
  if (trigger === 'any_state_elsewhere') return otherStates.length > 0;
  return otherStates.some(
    (r) => (r.state === 'opted_out' && r.provenance === 'explicit') || r.state === 'suppressed',
  );
}

/** Review trigger evaluation (§11.2). */
async function maybeQueueReview(
  identityId: number,
  channel: Channel,
  eventId: number,
  originSystemId: string,
  initiatedByUserId: number | null,
): Promise<unknown> {
  if (policy.reviewTrigger === 'never') return { queued: false, reason: 'trigger disabled' };

  const others = await pool.query(
    `SELECT system_id, state, provenance FROM consent_states
      WHERE identity_id=$1 AND system_id <> $2`,
    [identityId, originSystemId],
  );
  if (!shouldQueueReview(policy.reviewTrigger, others.rows)) {
    return { queued: false, reason: 'no meaningful state elsewhere — recorded locally only' };
  }
  return createOrCoalesceReview(identityId, channel, eventId, originSystemId, initiatedByUserId);
}
