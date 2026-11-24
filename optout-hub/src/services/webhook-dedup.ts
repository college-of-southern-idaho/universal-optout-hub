import { pool } from '../db.js';

/**
 * Inbound-webhook de-duplication (replay/retry defense, migration 015). Records
 * each processed event's platform id; a repeat is skipped. Combined with the
 * signed-timestamp freshness check in the routes, this blocks both replays of
 * captured requests and double-processing of legitimate platform retries.
 */

/** How long to remember processed event ids. */
export const WEBHOOK_DEDUP_RETENTION_DAYS = 30;

/**
 * Atomically claim an event id. Returns true if this id is NEW (process the
 * event), false if it has already been seen (skip it — duplicate/replay).
 */
export async function markWebhookEventSeen(eventId: string): Promise<boolean> {
  const r = await pool.query(
    `INSERT INTO webhook_events (event_id) VALUES ($1)
       ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [eventId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Delete dedup records older than the retention window. Returns rows removed. */
export async function pruneWebhookEvents(days: number = WEBHOOK_DEDUP_RETENTION_DAYS): Promise<number> {
  const r = await pool.query(
    'DELETE FROM webhook_events WHERE received_at < now() - make_interval(days => $1)',
    [Math.max(1, Math.floor(days))],
  );
  return r.rowCount ?? 0;
}
