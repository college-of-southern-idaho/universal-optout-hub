-- Universal Opt-Out Hub: core schema (PostgreSQL)
-- Implements the consent data model from DESIGN.md §5–§7, §11.7

CREATE TABLE IF NOT EXISTS systems (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  -- Channel is consent classification, NOT transport.
  -- Email-to-SMS gateways MUST be 'sms'. (DESIGN.md §9)
  channel           TEXT NOT NULL CHECK (channel IN ('sms', 'email')),
  event_delivery    TEXT NOT NULL DEFAULT 'webhook'
                      CHECK (event_delivery IN ('webhook', 'poll', 'export')),
  can_write_optout  BOOLEAN NOT NULL DEFAULT TRUE,
  can_write_optin   BOOLEAN NOT NULL DEFAULT TRUE,
  vendor_suppression TEXT
);

CREATE TABLE IF NOT EXISTS identities (
  id               SERIAL PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('phone', 'email')),
  value_normalized TEXT NOT NULL UNIQUE,  -- E.164 / canonicalized email
  value_raw        TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Immutable consent evidence (DESIGN.md §5.3). Required for explicit opt-ins.
CREATE TABLE IF NOT EXISTS evidence (
  id               SERIAL PRIMARY KEY,
  identity_id      INT NOT NULL REFERENCES identities(id),
  channel          TEXT NOT NULL CHECK (channel IN ('sms', 'email')),
  method           TEXT NOT NULL,          -- e.g. 'START keyword', 'web form'
  consent_language TEXT,                   -- the language the consumer agreed to
  captured_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only event log (DESIGN.md §5.1). Never UPDATE or DELETE rows here.
CREATE TABLE IF NOT EXISTS consent_events (
  id                  SERIAL PRIMARY KEY,
  identity_id         INT NOT NULL REFERENCES identities(id),
  system_id           TEXT NOT NULL REFERENCES systems(id),
  channel             TEXT NOT NULL CHECK (channel IN ('sms', 'email')),
  direction           TEXT NOT NULL CHECK (direction IN ('opt_in', 'opt_out')),
  provenance          TEXT NOT NULL CHECK (provenance IN ('explicit', 'derived')),
  occurred_at         TIMESTAMPTZ NOT NULL,            -- platform's own timestamp
  received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_detail       TEXT,
  evidence_id         INT REFERENCES evidence(id),
  sync_origin_key     TEXT,                            -- set on hub-originated writes
  approval_request_id INT,                             -- links derived opt-ins to approvals
  actor               TEXT                             -- operator/approver for manual events
);
CREATE INDEX IF NOT EXISTS consent_events_identity_system
  ON consent_events (identity_id, system_id, occurred_at);

-- Materialized projection (DESIGN.md §5.2). Recomputable fold over consent_events.
CREATE TABLE IF NOT EXISTS consent_states (
  identity_id  INT NOT NULL REFERENCES identities(id),
  system_id    TEXT NOT NULL REFERENCES systems(id),
  state        TEXT NOT NULL CHECK (state IN ('unknown', 'opted_in', 'opted_out', 'suppressed')),
  provenance   TEXT CHECK (provenance IN ('explicit', 'derived')),
  as_of_event  INT REFERENCES consent_events(id),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (identity_id, system_id)
);

-- Simulated external platform suppression lists (mock adapters write here).
-- In production this table does not exist; adapters talk to real platform APIs.
CREATE TABLE IF NOT EXISTS platform_records (
  system_id      TEXT NOT NULL REFERENCES systems(id),
  identity_value TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('opted_in', 'opted_out', 'none')),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (system_id, identity_value)
);

-- Outstanding hub-originated writes, for echo suppression (DESIGN.md §8.2).
CREATE TABLE IF NOT EXISTS hub_writes (
  sync_origin_key TEXT PRIMARY KEY,
  identity_id     INT NOT NULL REFERENCES identities(id),
  system_id       TEXT NOT NULL REFERENCES systems(id),
  direction       TEXT NOT NULL CHECK (direction IN ('opt_in', 'opt_out')),
  issued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at    TIMESTAMPTZ
);

-- Opt-in propagation approval queue (DESIGN.md §11).
CREATE TABLE IF NOT EXISTS approval_requests (
  id               SERIAL PRIMARY KEY,
  identity_id      INT NOT NULL REFERENCES identities(id),
  channel          TEXT NOT NULL CHECK (channel IN ('sms', 'email')),
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'canceled')),
  version          INT NOT NULL DEFAULT 1,   -- optimistic concurrency (§11.8)
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL,
  decided_by       TEXT,
  decided_at       TIMESTAMPTZ,
  attestation_text TEXT,
  decision_note    TEXT
);
-- Coalescing key: at most one PENDING review per (identity, channel) (§11.3).
CREATE UNIQUE INDEX IF NOT EXISTS approval_pending_coalesce
  ON approval_requests (identity_id, channel) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS approval_request_events (
  request_id INT NOT NULL REFERENCES approval_requests(id),
  event_id   INT NOT NULL REFERENCES consent_events(id),
  PRIMARY KEY (request_id, event_id)
);

CREATE TABLE IF NOT EXISTS approval_targets (
  request_id          INT NOT NULL REFERENCES approval_requests(id),
  system_id           TEXT NOT NULL REFERENCES systems(id),
  preselected         BOOLEAN NOT NULL DEFAULT FALSE,  -- policy default (same-channel)
  selected            BOOLEAN,                          -- reviewer's decision
  snapshot_state      TEXT,                             -- state at render time (§11.7)
  snapshot_provenance TEXT,
  outcome             TEXT,                             -- 'written' | 'skipped_explicit_optout' | 'unwritable'
  result_event_id     INT REFERENCES consent_events(id),
  PRIMARY KEY (request_id, system_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id     SERIAL PRIMARY KEY,
  at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor  TEXT,
  action TEXT NOT NULL,
  detail JSONB
);

-- Reconciliation alerts: divergence the hub cannot correct (DESIGN.md §8.3).
CREATE TABLE IF NOT EXISTS reconcile_alerts (
  id          SERIAL PRIMARY KEY,
  identity_id INT NOT NULL REFERENCES identities(id),
  system_id   TEXT NOT NULL REFERENCES systems(id),
  expected    TEXT NOT NULL,
  observed    TEXT NOT NULL,
  reason      TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
