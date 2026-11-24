-- Persist the FULL consent-check response, not just decision + state, so the
-- exact answer the hub returned to the caller is retained as evidence
-- (ADR-0004 §7; § 227(c)(5) affirmative defense). `reason`, `as_of`, and
-- `advisory` were previously returned to the caller but never stored.
-- Nullable + IF NOT EXISTS so this is a safe, backfill-free add; historical
-- rows keep NULLs (their decision + state remain the material facts).
ALTER TABLE consent_checks
  ADD COLUMN IF NOT EXISTS reason   TEXT,
  ADD COLUMN IF NOT EXISTS as_of    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS advisory TEXT;
