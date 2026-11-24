-- 013_session_csrf.sql — per-session CSRF token (synchronizer-token pattern).
-- The console authenticates with a cookie session, so state-changing requests
-- need a CSRF defense beyond SameSite=Lax: each session carries a random token
-- the browser must echo in the X-CSRF-Token header on mutating requests. Nullable
-- so existing sessions keep working — resolveSession lazily backfills a token.
-- Additive, idempotent.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS csrf_token TEXT;
