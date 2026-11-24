-- 011_api_key_rate_limit.sql — per-key rate limit for the consent-check API
-- (ADR-0004 §8). Additive, idempotent, rerun-safe.
--
-- A single nullable knob per key: requests/second (burst == steady-state).
-- NULL means "use the hub-wide default" (policy.consentCheckRateLimitPerSec),
-- so existing keys keep working with no backfill. A value of 0 disables the
-- limit for that key (documented escape hatch for a trusted internal sender).
ALTER TABLE service_api_keys
  ADD COLUMN IF NOT EXISTS rate_limit_per_sec INT;
