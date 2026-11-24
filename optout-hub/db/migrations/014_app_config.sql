-- 014_app_config.sql — runtime configuration store (DESIGN.md §13).
-- The tunable policy/operational knobs (previously env-only in policy.ts) now
-- live here so an admin can change them from the console without a redeploy.
-- DB is authoritative; an env var only seeds the default when a key is absent.
-- Secrets (APP_SECRET, DATABASE_URL, OIDC secrets) are NEVER stored here.
-- Key/value; value is JSONB to hold strings, numbers, booleans, or lists.
-- Additive, idempotent.
CREATE TABLE IF NOT EXISTS app_config (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT
);
