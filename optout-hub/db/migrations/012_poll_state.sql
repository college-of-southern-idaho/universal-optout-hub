-- 012_poll_state.sql — cursor for poll-delivery inbound ingestion.
-- Poll-delivery platforms (e.g. Constant Contact) have no inbound webhook; the
-- poller (services/poller.ts) pulls opt-out/opt-in deltas on a timer and needs
-- to remember how far it has read per system. Config, not consent history, so
-- CASCADE on system delete is safe. Additive, idempotent.
CREATE TABLE IF NOT EXISTS poll_state (
  system_id      TEXT PRIMARY KEY REFERENCES systems(id) ON DELETE CASCADE,
  last_polled_at TIMESTAMPTZ NOT NULL
);
