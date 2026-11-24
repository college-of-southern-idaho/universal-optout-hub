# ADR 0003 — Service configuration, adapter registry, and service lifecycle

**Status:** Accepted
**Date:** June 2026
**Deciders:** Architecture/implementation session
**Related:** DESIGN.md §9/§9.1 (adapter contract & implementation), §10a (topology), §12 (RBAC), §13.1 (service configuration); [ADR 0002](ADR-0002-service-discovered-topology.md)

---

## 1. Context

ADR 0002 established service-discovered, reporting-only topology and confirmed the hub as a reconciliation hub. Turning that into an operable product needed three things the design hadn't yet pinned down:

1. A way for admins to **onboard and configure sending services** — without hand-editing the database — and a model for storing each service's credentials safely.
2. A way to support **many platforms** (not just the four initial higher-ed targets), since the hub is meant for any organization under universal opt-out obligations.
3. A way to **remove a service** without destroying consent history.

## 2. Decision

### 2.1 Service catalog + two-phase admin configuration

A static **adapter catalog** (`src/adapters/catalog.ts`) is the single source of truth for the known platform types (35 at time of writing, spanning CPaaS/SMS, campaign SMS, higher-ed texting, email ESPs, and transactional email). Each entry declares channel (and whether channel-locked), capability defaults, topology granularity, and the credential fields the operator supplies. Defaults encode two patterns:

- **API-managed suppression** — the hub reads and writes opt-out state and discovers lists/pools/groups.
- **Withhold-only** — the platform keeps no caller-writable list, so opt-out is enforced by withholding sends. This is the documented reality for Telesign, **Twilio** (Advanced Opt-Out is Console-only; no opt-out API), the higher-ed texting tools, and email-to-SMS gateways.

Admins configure a service through a two-phase screen: **register & connect** (pick type, name, credentials, test connection) then **discover & review** (pull topology, annotate gaps). The UI renders entirely from the catalog, so adding a type is a catalog entry plus, when ready, a client.

### 2.2 Write-only encrypted credential store

Credentials live in `system_credentials`, encrypted at rest with AES-256-GCM (key derived from `APP_SECRET` via scrypt — Node built-in, no native addon, matching the password-hashing posture). They are **never returned through the API**; reads expose only metadata (which keys are set, a last-4 hint, OAuth `expires_at`). Decryption is server-only, for live clients at send/discovery time.

### 2.3 Adapter registry with dispatch and mock fallback

`src/adapters/registry.ts` builds one adapter per active system, dispatching on `adapter_type` through a factory table. A type with no live client — or whose required credentials are not yet set — falls back to `MockAdapter`, so every service is demoable until fully configured; once a real client exists and credentials are present, the registry switches to it on reload. The contract is an explicit `Adapter` interface (`contract.ts`) that both the mock and live clients implement. Live clients implemented: **SendGrid** and **Twilio**.

### 2.4 Service lifecycle: archive vs. guarded delete

- **Archive (soft delete)** marks `archived_at`; the registry skips archived systems (no sends, discovery, or reconciliation) but their consent history is retained for attribution. Reversible.
- **Hard delete** is permitted only when a system has **no** consent history. The consent-history tables (`consent_events`, `consent_states`, `hub_writes`, `approval_targets`, `reconcile_alerts`) keep `RESTRICT` foreign keys to `systems`, so the database refuses any delete that would destroy consent records — the append-only log is protected at the schema level, independent of application logic.

## 3. What this does not change

Consent semantics are untouched. Nothing in the configuration path, the registry, or the credential store is read by a consent decision (the ADR 0002 §2.2 firewall holds). Topology stays reporting/attribution only. Capability flags govern how the hub *talks to* a service, never what consent it records.

## 4. Consequences

**Positive:** services are onboarded and removed safely from the UI; the catalog makes platform coverage a data concern; the registry lets live clients land incrementally without destabilizing unconfigured services; consent history cannot be deleted by mistake.

**Negative / risks:** the live clients' outbound half (auth, discovery, suppression writes) is live; signature-verified inbound webhooks (SendGrid Event Webhook, Twilio STOP/START) are now wired into ingest (`src/services/webhooks.ts`) but only unit-tested at the mapping/signature layer, not exercised end-to-end with real platform deliveries. OAuth token refresh is stubbed (schema/fields present, logic pending). Non-secret connection params (region, domain, base URL) are currently stored write-only like secrets, pending a move onto the system row.

## 5. Disclaimer

Regulatory statements are summaries for engineering motivation, not legal advice.
