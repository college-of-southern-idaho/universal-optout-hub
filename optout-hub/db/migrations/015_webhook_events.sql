-- 015_webhook_events.sql — inbound webhook de-duplication (replay/retry defense).
-- Each processed webhook event's platform id is recorded here; a repeat (a replay
-- or a legitimate platform retry) is skipped rather than ingested twice. The id
-- is part of the platform's signed payload, so it can't be forged. Rows are
-- pruned after a retention window (services/webhook-dedup.ts). Additive, idempotent.
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id    TEXT PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhook_events_received ON webhook_events (received_at);
