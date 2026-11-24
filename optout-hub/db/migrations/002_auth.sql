-- Authentication & RBAC (DESIGN.md forthcoming §16)
-- One identity table; credentials are sources that attach to it.

CREATE TABLE IF NOT EXISTS users (
  id           SERIAL PRIMARY KEY,
  username     TEXT NOT NULL UNIQUE,            -- login + audit display handle
  display_name TEXT NOT NULL,
  email        TEXT,
  role         TEXT NOT NULL DEFAULT 'viewer'
                 CHECK (role IN ('viewer', 'operator', 'approver', 'admin')),
  status       TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'disabled')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Local password credential (at most one per user).
CREATE TABLE IF NOT EXISTS local_credentials (
  user_id       INT PRIMARY KEY REFERENCES users(id),
  password_hash TEXT NOT NULL,                  -- scrypt$N$r$p$salt$hash
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  failed_count  INT NOT NULL DEFAULT 0,
  locked_until  TIMESTAMPTZ
);

-- SSO identity bindings. Protocol-agnostic: OIDC today, SAML later —
-- both reduce to (issuer, subject) → user.
CREATE TABLE IF NOT EXISTS sso_links (
  id            SERIAL PRIMARY KEY,
  user_id       INT NOT NULL REFERENCES users(id),
  provider      TEXT NOT NULL,                  -- config key, e.g. 'entra', 'dev'
  issuer        TEXT NOT NULL,
  subject       TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ,
  UNIQUE (issuer, subject)
);

-- Server-side sessions: revocation takes effect immediately (no JWTs for
-- the human console — removing an approver role must bite NOW).
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,                  -- 256-bit random, hex
  user_id    INT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  ip         TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);

-- Transient state for the OIDC authorization-code + PKCE flow.
CREATE TABLE IF NOT EXISTS sso_login_states (
  state         TEXT PRIMARY KEY,
  provider      TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Real attribution on the records that matter legally.
ALTER TABLE consent_events     ADD COLUMN IF NOT EXISTS actor_user_id INT REFERENCES users(id);
ALTER TABLE approval_requests  ADD COLUMN IF NOT EXISTS initiated_by_user_id INT REFERENCES users(id);
ALTER TABLE approval_requests  ADD COLUMN IF NOT EXISTS decided_by_user_id INT REFERENCES users(id);
ALTER TABLE audit_log          ADD COLUMN IF NOT EXISTS actor_user_id INT REFERENCES users(id);
