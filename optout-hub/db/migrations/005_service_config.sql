-- Service-configuration surface for the admin "Services" screens.
--
-- Two-phase flow (DESIGN.md §9; phase 2 is ADR-0002 topology):
--   1. Register & connect — choose an adapter type, name the system, store
--      credentials SERVER-SIDE (write-only; never read back through the API),
--      and test the connection.
--   2. Discover & review — pull the service's pools/codes via the existing
--      topology sync (004), confirm, and annotate where discovery returns
--      nothing.
--
-- COMPLIANCE NOTE (ADR-0002 §2.2): nothing added here is read by a consent
-- decision. adapter_type and the capability flags shape how the hub *talks to*
-- a service; topology stays reporting/attribution only; credentials are never
-- a consent input. This migration is purely additive.

-- Which adapter implementation backs a system. In this PoC every type is served
-- by the mock adapter; in production each maps to a real client (Twilio,
-- Telesign, Constant Contact, an email-to-SMS gateway). The set mirrors
-- src/adapters/catalog.ts.
ALTER TABLE systems
  ADD COLUMN IF NOT EXISTS adapter_type TEXT NOT NULL DEFAULT 'mock'
    CHECK (adapter_type IN
      ('mock', 'twilio', 'telesign', 'constant_contact', 'email_sms_gateway'));

-- Phase-1 connection lifecycle, for the admin list only. 'draft' = registered,
-- not yet tested; 'connected' = last test passed; 'error' = last test failed.
-- Operational status — never consulted by consent logic.
ALTER TABLE systems
  ADD COLUMN IF NOT EXISTS connection_status TEXT NOT NULL DEFAULT 'draft'
    CHECK (connection_status IN ('draft', 'connected', 'error'));
ALTER TABLE systems ADD COLUMN IF NOT EXISTS last_test_at     TIMESTAMPTZ;
ALTER TABLE systems ADD COLUMN IF NOT EXISTS last_test_detail TEXT;
ALTER TABLE systems ADD COLUMN IF NOT EXISTS created_at       TIMESTAMPTZ NOT NULL DEFAULT now();

-- Server-side credential store. Secrets are encrypted at rest (AES-256-GCM,
-- key derived from APP_SECRET via Node's built-in crypto — no native addon,
-- the same posture as scrypt password hashing in 002) and are NEVER returned
-- through the API. Reads expose only metadata: which keys are set, a
-- non-sensitive last-4 hint, and when/by whom they were last written.
CREATE TABLE IF NOT EXISTS system_credentials (
  system_id          TEXT NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  cred_key           TEXT NOT NULL,           -- e.g. 'auth_token', 'api_key'
  secret_enc         TEXT NOT NULL,           -- base64(iv | authTag | ciphertext)
  last4              TEXT,                     -- non-sensitive display hint only
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by         TEXT,
  updated_by_user_id INT REFERENCES users(id),
  PRIMARY KEY (system_id, cred_key)
);
