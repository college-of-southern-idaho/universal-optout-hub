-- The operational audit_log (migration 001) had no retention and grows
-- unbounded — one row per ingested event, scheduled reconcile, alert, etc.
-- It is now pruned on a window (default 14 days), EXCEPT a small set of
-- low-volume, compliance-relevant actions kept indefinitely (approval
-- decisions/auto-cancels, config-change history, API-key create/revoke);
-- see services/retention.ts. The authoritative legal evidence never lived
-- here — it is in consent_events, approval_requests, and consent_checks
-- (the last with its own ~4-year retention, migration 009).
--
-- This index makes the time-windowed DELETE efficient on a large table.
-- Idempotent; rerun-safe.

CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log (at);
