-- Service deletion (DESIGN.md §9). Deleting a sending service must never
-- destroy consent history: consent_events (the append-only log), consent_states,
-- hub_writes, approval_targets, and reconcile_alerts all reference systems(id)
-- with ON DELETE RESTRICT, so the database itself blocks a hard delete of any
-- system that has ever recorded consent. That is the safety net.
--
-- The application offers two operations (services/systems.ts):
--   archive  — soft delete for a system with history: it stops being used for
--              sends/discovery/reconciliation (the adapter registry skips
--              archived systems) but all history is retained for attribution.
--   delete   — hard delete, allowed ONLY when the system has no consent history;
--              config/metadata children (topology, annotations, platform_records,
--              credentials) are removed in a transaction.
--
-- This migration is purely additive and idempotent (the runner reapplies every
-- migration each run).

ALTER TABLE systems ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

-- Active systems are the common lookup (registry load, matrix). Partial index
-- keeps that path fast as archived rows accumulate.
CREATE INDEX IF NOT EXISTS systems_active_idx ON systems (id) WHERE archived_at IS NULL;
