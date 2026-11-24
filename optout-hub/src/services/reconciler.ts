import { randomUUID } from 'node:crypto';
import { pool } from '../db.js';
import { allAdapters } from '../adapters/registry.js';
import { ingest, deriveSuppression } from './ingest.js';
import { recomputeIdentity } from './projection.js';
import { cascades } from './categories.js';
import { policy } from '../core/policy.js';
import { log } from '../core/logger.js';

/**
 * The reconciliation safety net (DESIGN.md §8). Ingest-time propagation
 * handles the common case; this loop catches drift from missed webhooks,
 * late batch events that changed a fold result, or failed writes.
 *
 * For each (identity, system) with a projected state, compare expected
 * against the platform's observed record; issue corrective writes where
 * the adapter allows them, raise alerts where it doesn't.
 *
 * Deliberate asymmetry: the reconciler only auto-corrects toward
 * SUPPRESSION. An expected opted_in vs observed opted_out is surfaced as
 * an alert, never auto-written — re-opt-ins flow exclusively through the
 * human-gated approval path (§11), and a platform-side opt-out the hub
 * hasn't ingested yet must never be steamrolled.
 */
export async function reconcile(): Promise<{
  checked: number;
  corrected: { identity: string; system: string }[];
  alerts: { identity: string; system: string; expected: string; observed: string }[];
}> {
  const corrected: { identity: string; system: string }[] = [];
  const alerts: { identity: string; system: string; expected: string; observed: string }[] = [];

  const rows = await pool.query(
    `SELECT cs.identity_id, cs.system_id, cs.state, cs.provenance, i.value_normalized
       FROM consent_states cs JOIN identities i ON i.id = cs.identity_id`,
  );

  const adapters = new Map(allAdapters().map((a) => [a.system.id, a]));

  for (const r of rows.rows) {
    const adapter = adapters.get(r.system_id);
    if (!adapter) continue;
    const observed = await adapter.observe(r.value_normalized);
    const expectedOut = r.state === 'opted_out' || r.state === 'suppressed';
    const observedOut = observed === 'opted_out';

    if (expectedOut === observedOut) continue;

    if (expectedOut && !observedOut) {
      // Test mode (enableOutboundWrites=off): never push corrections to platforms.
      if (!policy.enableOutboundWrites) {
        log.info('outbound_write_suppressed', { system: r.system_id, identity: r.value_normalized, direction: 'opt_out', reason: 'enableOutboundWrites=off (reconciler)' });
        continue;
      }
      // Drift toward under-suppression: correct it if we can.
      if (adapter.system.can_write_optout) {
        const key = randomUUID();
        await pool.query(
          `INSERT INTO hub_writes (sync_origin_key, identity_id, system_id, direction)
           VALUES ($1,$2,$3,'opt_out')`,
          [key, r.identity_id, r.system_id],
        );
        const w = await adapter.write(r.value_normalized, 'opt_out', key);
        if (w.ok && w.echo) {
          await ingest({
            system_id: w.echo.system_id,
            identity_value: w.echo.identity_value,
            direction: w.echo.direction,
            occurred_at: w.echo.occurred_at,
            sync_origin_key: w.echo.sync_origin_key,
            source_detail: 'platform webhook (echo, reconciler)',
          });
        }
        corrected.push({ identity: r.value_normalized, system: r.system_id });
      } else {
        await pool.query(
          `INSERT INTO reconcile_alerts (identity_id, system_id, expected, observed, reason)
           VALUES ($1,$2,$3,$4,'unwritable divergence')`,
          [r.identity_id, r.system_id, r.state, observed],
        );
        alerts.push({
          identity: r.value_normalized,
          system: r.system_id,
          expected: r.state,
          observed,
        });
      }
    } else {
      // Expected reachable, observed opted_out: alert only (see header comment).
      await pool.query(
        `INSERT INTO reconcile_alerts (identity_id, system_id, expected, observed, reason)
         VALUES ($1,$2,$3,$4,'platform reports opt-out the hub has not ingested; investigate — never auto-overridden')`,
        [r.identity_id, r.system_id, r.state, observed],
      );
      alerts.push({
        identity: r.value_normalized,
        system: r.system_id,
        expected: r.state,
        observed,
      });
    }
  }

  // --- Backfill pass (§10) -------------------------------------------------
  // An identity opted out anywhere must be suppressed on every active system,
  // including services added AFTER the opt-out. Those have no consent_state row
  // yet, so the per-state pass above never visits them — this is the gap behind
  // "I added a service and the reconciler didn't suppress an already-opted-out
  // person." Group the states we already loaded by identity and derive the
  // missing suppressions.
  const activeIds = allAdapters().map((a) => a.system.id);
  // Category + channel of every system — including archived source systems that
  // still hold consent history — so backfill can decide cascade direction by
  // category and keep it within the opt-out's channel.
  const sysRows = (await pool.query<{ id: string; category: string; channel: string }>(
    'SELECT id, category, channel FROM systems',
  )).rows;
  const catMap = new Map(sysRows.map((c) => [c.id, c.category] as const));
  const chanMap = new Map(sysRows.map((c) => [c.id, c.channel] as const));
  const categoryOf = (id: string): string => catMap.get(id) ?? 'marketing';
  const channelOf = (id: string): string => chanMap.get(id) ?? 'sms';

  const byIdentity = new Map<number, { value: string; stated: Set<string>; sourceCats: Set<string>; sourceChannels: Set<string> }>();
  for (const r of rows.rows) {
    let e = byIdentity.get(r.identity_id);
    if (!e) { e = { value: r.value_normalized, stated: new Set(), sourceCats: new Set(), sourceChannels: new Set() }; byIdentity.set(r.identity_id, e); }
    e.stated.add(r.system_id);
    // Only EXPLICIT opt-outs are cascade sources — a derived suppression is a
    // consequence, not a new source (prevents transitive cross-category leakage).
    if (r.state === 'opted_out' && r.provenance === 'explicit') {
      e.sourceCats.add(categoryOf(r.system_id));
      e.sourceChannels.add(channelOf(r.system_id));
    }
  }
  for (const [identityId, { value, stated, sourceCats, sourceChannels }] of byIdentity) {
    const targets = backfillTargets(activeIds, stated, sourceCats, sourceChannels, categoryOf, channelOf, cascades);
    if (!targets.length) continue;
    for (const sysId of targets) {
      const res = await deriveSuppression(identityId, value, sysId, 'backfill: opt-out predates this service');
      if (res.result.startsWith('written')) corrected.push({ identity: value, system: sysId });
      else if (res.result === 'alert_unwritable') {
        alerts.push({ identity: value, system: sysId, expected: 'opted_out', observed: 'unwritable' });
      }
    }
    await recomputeIdentity(identityId);
  }

  return { checked: rows.rowCount ?? 0, corrected, alerts };
}

/**
 * Pure: return the system ids that need a backfilled suppression — active
 * systems that carry no consent state yet (added after the opt-out), on the
 * SAME channel as the identity's opt-out (consent is channel-scoped), whose
 * category is a matrix target of at least one category the identity has an
 * EXPLICIT opt-out in. Protected targets are excluded by `cascadeFn`. Exported
 * for testing without a database.
 */
export function backfillTargets(
  activeSystemIds: string[],
  statedSystems: Set<string>,
  optOutSourceCategories: Set<string>,
  optOutSourceChannels: Set<string>,
  categoryOf: (systemId: string) => string,
  channelOf: (systemId: string) => string,
  cascadeFn: (sourceCat: string, targetCat: string) => boolean,
): string[] {
  if (optOutSourceCategories.size === 0) return [];
  return activeSystemIds.filter((id) => {
    if (statedSystems.has(id)) return false;
    if (!optOutSourceChannels.has(channelOf(id))) return false;   // never cross channels
    const target = categoryOf(id);
    for (const src of optOutSourceCategories) if (cascadeFn(src, target)) return true;
    return false;
  });
}
