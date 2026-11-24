-- 009_consent_check_api.sql — consent-check API for Class B senders (ADR-0004).
-- Two additive tables: per-system service API keys, and a dedicated, high-volume
-- check-audit log kept separate from audit_log so its retention is governed on
-- its own (ADR-0004-verification item 3). Idempotent; rerun-safe.

CREATE TABLE IF NOT EXISTS service_api_keys (
  id           SERIAL PRIMARY KEY,
  -- Config, not consent history: CASCADE is safe (unlike the RESTRICT FKs the
  -- consent-history tables keep, ADR-0003 §2.4).
  system_id    TEXT NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  label        TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,      -- sha256 of the presented key; no plaintext stored
  key_prefix   TEXT NOT NULL,             -- leading chars, for display only
  created_by   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS service_api_keys_system ON service_api_keys (system_id);

CREATE TABLE IF NOT EXISTS consent_checks (
  id            BIGSERIAL PRIMARY KEY,
  checked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Keep the audit row if the key is later deleted.
  api_key_id    INT REFERENCES service_api_keys(id) ON DELETE SET NULL,
  -- Deliberately NOT a FK to systems: pruning/deleting a system must never block
  -- on check logs, and check history should survive a system's hard-delete.
  system_id     TEXT NOT NULL,
  channel       TEXT NOT NULL CHECK (channel IN ('sms','email')),
  identity_norm TEXT NOT NULL,
  decision      TEXT NOT NULL CHECK (decision IN ('suppress','allow','error')),
  state         TEXT
);
-- Supports the split-retention prune (suppress ~4yr, allow ~30-90d).
CREATE INDEX IF NOT EXISTS consent_checks_prune ON consent_checks (decision, checked_at);
