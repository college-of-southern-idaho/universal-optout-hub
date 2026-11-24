import { pool } from '../db.js';
import { allAdapters } from '../adapters/registry.js';
import { ingest } from './ingest.js';
import type { Adapter, PolledEvent } from '../adapters/contract.js';

/**
 * Poll-based inbound ingestion (roadmap: inbound events → ingest, for platforms
 * with no webhook). For each active adapter that implements pollOptOuts, pull
 * the events changed since the system's cursor and feed them through ingest —
 * the same entry point the webhook handlers use — so propagation, precedence,
 * and audit all behave identically to a webhook-delivered opt-out.
 *
 * Cursors are persisted per system in poll_state (migration 012), so a restart
 * resumes where it left off rather than re-reading the whole history. Runs on
 * the scheduler (POLL_INTERVAL_MINUTES); a manual admin route also triggers it.
 */

export interface PollSummary {
  system: string;
  fetched: number;
  ingested: number;
  errors: number;
}

/**
 * Pure: the next cursor given the previous one and the events just ingested.
 * The newest event time, or the previous cursor if nothing newer arrived.
 */
export function nextCursor(prevIso: string | null, events: PolledEvent[]): string | null {
  let maxMs = prevIso ? Date.parse(prevIso) : NaN;
  for (const e of events) {
    const ms = e.occurred_at.getTime();
    if (Number.isNaN(maxMs) || ms > maxMs) maxMs = ms;
  }
  return Number.isNaN(maxMs) ? prevIso : new Date(maxMs).toISOString();
}

async function getCursor(systemId: string): Promise<string | null> {
  const r = await pool.query<{ last_polled_at: Date }>(
    'SELECT last_polled_at FROM poll_state WHERE system_id=$1', [systemId],
  );
  return r.rows[0]?.last_polled_at ? r.rows[0].last_polled_at.toISOString() : null;
}

async function setCursor(systemId: string, iso: string): Promise<void> {
  await pool.query(
    `INSERT INTO poll_state (system_id, last_polled_at) VALUES ($1,$2)
     ON CONFLICT (system_id) DO UPDATE SET last_polled_at=$2`,
    [systemId, new Date(iso)],
  );
}

/** Poll one adapter and ingest its events. Advances the cursor only if it moved. */
export async function pollSystem(adapter: Adapter): Promise<PollSummary> {
  const systemId = adapter.system.id;
  const cursor = await getCursor(systemId);
  const events = await adapter.pollOptOuts!(cursor);
  const source = `${adapter.system.adapter_type} poll (consumer)`;
  let ingested = 0;
  let errors = 0;
  for (const e of events) {
    try {
      await ingest({
        system_id: systemId,
        identity_value: e.identity_value,
        direction: e.direction,
        occurred_at: e.occurred_at,
        source_detail: source,
      });
      ingested++;
    } catch (err: any) {
      errors++;
      console.error(`[poller] ${systemId} ingest failed for ${e.identity_value}:`, err.message);
    }
  }
  const advanced = nextCursor(cursor, events);
  if (advanced && advanced !== cursor) await setCursor(systemId, advanced);
  return { system: systemId, fetched: events.length, ingested, errors };
}

/** Poll every active adapter that supports polling. */
export async function pollAll(): Promise<PollSummary[]> {
  const summaries: PollSummary[] = [];
  for (const a of allAdapters()) {
    if (typeof a.pollOptOuts !== 'function') continue;
    try {
      summaries.push(await pollSystem(a));
    } catch (e: any) {
      console.error(`[poller] ${a.system.id} poll failed:`, e.message);
      summaries.push({ system: a.system.id, fetched: 0, ingested: 0, errors: 1 });
    }
  }
  return summaries;
}
