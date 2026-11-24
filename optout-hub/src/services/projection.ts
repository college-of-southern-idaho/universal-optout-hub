import { pool } from '../db.js';
import { foldState } from '../core/precedence.js';
import type { ConsentEvent, FoldedState } from '../core/types.js';

/**
 * Recompute the materialized projection for one identity across every
 * system it has events for (DESIGN.md §5.2). Called after every ingest —
 * including late-arriving events, which is what makes occurred_at ordering
 * actually take effect.
 */
export async function recomputeIdentity(identityId: number): Promise<Map<string, FoldedState>> {
  const r = await pool.query<ConsentEvent>(
    `SELECT id, identity_id, system_id, channel, direction, provenance,
            occurred_at, source_detail
       FROM consent_events WHERE identity_id=$1`,
    [identityId],
  );
  const bySystem = new Map<string, ConsentEvent[]>();
  for (const e of r.rows) {
    const list = bySystem.get(e.system_id) ?? [];
    list.push(e);
    bySystem.set(e.system_id, list);
  }
  const result = new Map<string, FoldedState>();
  for (const [systemId, events] of bySystem) {
    const folded = foldState(events);
    result.set(systemId, folded);
    await pool.query(
      `INSERT INTO consent_states (identity_id, system_id, state, provenance, as_of_event, updated_at)
       VALUES ($1,$2,$3,$4,$5,now())
       ON CONFLICT (identity_id, system_id)
       DO UPDATE SET state=$3, provenance=$4, as_of_event=$5, updated_at=now()`,
      [identityId, systemId, folded.state, folded.provenance, folded.as_of_event],
    );
  }
  return result;
}

export async function getStates(identityId: number): Promise<
  { system_id: string; state: string; provenance: string | null }[]
> {
  const r = await pool.query(
    `SELECT system_id, state, provenance FROM consent_states WHERE identity_id=$1 ORDER BY system_id`,
    [identityId],
  );
  return r.rows;
}
