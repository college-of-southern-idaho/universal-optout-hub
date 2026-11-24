-- Reporting module supporting indexes (DESIGN.md §14 audit/recordkeeping).
-- Read-only: no table or column changes. The reporting module queries over the
-- existing append-only log and projections; these indexes keep identity lookup,
-- audit search, sync-lag, and activity reports fast as the log grows.

-- User-action audit search: filter by actor, action type, and time window.
CREATE INDEX IF NOT EXISTS audit_log_actor_user ON audit_log (actor_user_id);
CREATE INDEX IF NOT EXISTS audit_log_action     ON audit_log (action);
CREATE INDEX IF NOT EXISTS audit_log_at         ON audit_log (at);

-- Activity/volume and sync-lag scans walk events by time and direction.
-- (An (identity_id, system_id, occurred_at) index already exists from 001.)
CREATE INDEX IF NOT EXISTS consent_events_received_at ON consent_events (received_at);
CREATE INDEX IF NOT EXISTS consent_events_direction   ON consent_events (direction, occurred_at);

-- Open-liability report: outstanding (unconfirmed) hub-originated opt-out writes.
CREATE INDEX IF NOT EXISTS hub_writes_unconfirmed
  ON hub_writes (issued_at) WHERE confirmed_at IS NULL;
