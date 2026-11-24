# Quickstart — Run the Consent Hub Locally

[![CI](https://github.com/college-of-southern-idaho/IT-UniversalOptOut/actions/workflows/ci.yml/badge.svg)](https://github.com/college-of-southern-idaho/IT-UniversalOptOut/actions/workflows/ci.yml)

> **This is the first hands-on step of the setup journey.** Get the hub running on your machine, click through the console, and see the consent model in action. When you're ready to roll it out for your organization, follow the **[Setup Guide](SETUP-GUIDE.md)** — the linear, start-to-finish path (this Quickstart is its "run it locally" stage).

A runnable build of the universal opt-out synchronization hub described in `DESIGN.md`. Node.js + TypeScript + Express + PostgreSQL. An admin **Services** screen configures sending services from a catalog of 35 SMS/email platform types; seven of them — **SendGrid**, **Twilio**, **Constant Contact**, **Telesign**, **Amazon SNS (SMS)**, **Amazon SES (email)**, and **Azure Communication Services (SMS)** — have live API clients (real authentication, topology discovery, suppression read/write where the platform allows it, OAuth token refresh + poll-based ingestion for Constant Contact, inbound STOP/START for Telesign/Twilio, Twilio opt-out writes via the Consent Management API, SigV4-signed AWS clients — SNS opt-out reads / opt-in writes, SES suppression-list read/add/remove — and ACS HMAC-signed opt-out check/add/remove), and the rest are simulated by a mock adapter that behaves like the real ones — including the withhold-only opt-out shape of platforms like Telesign and Twilio, whose STOP handling the hub cannot reverse by writing.

> The application lives in the **`optout-hub/`** directory. Run the commands below from there, and note that the code paths referenced throughout this document (`src/…`, `db/…`, `web/…`, `test/…`, `examples/…`) are relative to `optout-hub/`.

## Run it

Prerequisites: Node 20+, and either Docker or a local PostgreSQL 16.

```bash
cd optout-hub

# 1. Database (skip if you have local Postgres matching .env.example)
docker compose up -d

# 2. Install, configure, migrate, seed
npm install
cp .env.example .env          # set APP_SECRET before storing any service credentials
npm run migrate               # applies db/migrations/001–017 (idempotent; rerun-safe)
npm run seed                  # seeds the demo platforms + bootstrap users

# 3. See the whole design exercised end to end (recommended first step)
npm run demo

# 4. Unit tests (precedence engine, service config, adapter mappers) — no DB needed
npm test

# 5. Integration tests (DB-backed ingest/approvals/consent-check/reporting + a few API routes)
#    Point DATABASE_URL at a THROWAWAY *_test database, then:
createdb optout_hub_test   # or any Postgres you don't mind wiping
DATABASE_URL=postgres://user:pass@localhost:5432/optout_hub_test npm run migrate
DATABASE_URL=postgres://user:pass@localhost:5432/optout_hub_test npm run test:integration

# 6. The console UI + API
npm run dev          # then open http://localhost:3000
```

`npm test` runs the pure-logic suite (no database) and is what CI/pre-merge relies on. `npm run test:integration` exercises the real DB-backed paths against a throwaway Postgres: it TRUNCATEs and reseeds between tests, so it **refuses to run unless the database name ends in `_test`** (override with `HUB_ALLOW_NONTEST_DB=1`), and **skips gracefully** if no database is reachable. Each test file runs in its own process, one at a time (`--test-concurrency=1`), since they share the one database.

`npm run demo` walks eight scenarios and prints the consent matrix after each: STOP propagating everywhere; START triggering a gated review with same-channel targets preselected; an approval where the reviewer's selection of an explicitly-opted-out system is skipped by the precedence engine; a late-arriving batch event re-folding by `occurred_at`; proof that echoes of hub writes are never recorded as consumer events; auto-cancel of a pending review the moment an opt-out arrives; the reconciler correcting simulated drift from a missed webhook; and service-discovered topology (ADR-0002) — discovering Twilio's sender pools, picking up a code added at the service on the next sync, surfacing a discovery-vs-annotation conflict without resolving it, and attributing event volume to departments while consent decisions stay blind to topology.

## Where the design lives in the code

| DESIGN.md | Code |
|---|---|
| §4 Identity normalization | `src/core/normalize.ts` |
| §5 Consent data model | `db/migrations/001_init.sql` |
| §6–§7 State machine & precedence rules | `src/core/precedence.ts` + `test/precedence.test.ts` |
| §8 Reconciliation loop, echo suppression, backfill onto later-added systems (§8.5) | `src/services/ingest.ts` (incl. `deriveSuppression`), `src/services/reconciler.ts` (`backfillTargets`) + `test/reconciler.test.ts` |
| §9 Adapter capability contract | `src/adapters/contract.ts`, `src/adapters/mock.ts`, `demo/seed.ts` |
| §9.1 Catalog, registry, live clients | `src/adapters/catalog.ts` (35 types), `src/adapters/registry.ts` (dispatch + mock fallback), `src/adapters/sendgrid.ts`, `src/adapters/twilio.ts`, `src/adapters/credential-store.ts` |
| §10 Opt-out propagation | `propagateOptOut` in `src/services/ingest.ts` |
| §11 Approval gate (coalescing, attestation, auto-cancel, TTL, versioning) | `src/services/approvals.ts` |
| §12 Manual interface | `web/index.html` (markup + styles) and `web/app.js` (console logic; all events bound via delegation so the CSP needs no `script-src 'unsafe-inline'`), `src/api/server.ts` |
| §13 Configuration surface (DB-backed, admin-editable) | `src/core/policy.ts` (live object) + `src/core/config-schema.ts` + `test/config-schema.test.ts`, `app_config` table (`db/migrations/014_app_config.sql`), `GET/PUT /api/config` in `src/api/server.ts`, Settings screen in `web/index.html` |
| §13.1 Service configuration (register/connect, discover/review, archive/delete) | `src/services/systems.ts`, service routes in `src/api/server.ts`, Services screen in `web/index.html`, migrations `005`–`007` |
| §13.2 Deployment branding (Appearance) | `src/core/branding.ts` + `test/branding.test.ts`, `/api/branding` routes in `src/api/server.ts`, `db/migrations/008_branding.sql` |
| Consent-check API (ADR-0004, Class B) | `src/services/consent-check.ts` + `test/consent-check.test.ts` + `test/consent-report.test.ts`, service-key auth in `src/auth/apikeys.ts`, `POST /api/v1/consent/check`, `GET /api/v1/consent/suppressions`, `POST /api/v1/consent/report` (sender-reported opt-outs) + key-management routes in `src/api/server.ts`, `db/migrations/009_consent_check_api.sql` |
| Inbound webhooks + Twilio Event Streams sink | `src/services/webhooks.ts` (`mapTwilioInbound`, `mapTwilioEvents`, `routeTwilioEvent`, `mapSendgridEvents`, `mapTelesignInbound` + signature verifiers) + `test/webhooks.test.ts`, routes `POST /api/webhooks/{twilio,twilio-events,sendgrid,telesign}/<system>` in `src/api/server.ts` |
| §10 Opt-out propagation (category cascade) | `src/services/categories.ts` (registry, matrix, `cascades`/`isProtectedCategory`) + `test/categories.test.ts`, `propagateOptOut`/`deriveSuppression` in `src/services/ingest.ts`, category-aware backfill in `src/services/reconciler.ts` + `test/reconciler.test.ts`, `db/migrations/016_consent_categories.sql`, `GET/POST /api/categories` + `/api/categories/cascade` in `src/api/server.ts`, editor in `web/index.html` |
| Authentication & RBAC | `db/migrations/002_auth.sql`, `src/auth/*` |

## Admin menu (Services, Users, Settings, Appearance)

Admin-only screens live under a single **Admin** dropdown that appears only for users with admin access — Services, Users, Settings, and Appearance. Non-admins never see the menu.

### Services

Admins manage sending services from **Admin → Services**. Adding one is two phases:

1. **Register & connect** — pick a platform type (the dropdown is rendered from the 35-entry catalog), name it, give it a permanent id, choose its **message category** (marketing / transactional / emergency — extensible in Settings; drives opt-out cascade, §10), and enter credentials. Credentials are encrypted at rest (AES-256-GCM, key from `APP_SECRET`) and are **never read back** — the UI only shows which keys are set, a last-4 hint, and any OAuth expiry. `APP_SECRET` (and `DATABASE_URL`, `OIDC_CLIENT_SECRET`) can be supplied from a mounted file via `<NAME>_FILE`; production refuses to boot on a missing/weak `APP_SECRET`, and `npm run reencrypt` rotates the key (re-encrypts the credential store from `APP_SECRET_OLD` → `APP_SECRET`). **Test connection** runs a checklist and, for a live client, a real API probe.
2. **Discover & review** — pull the service's pools/groups/codes and annotate where discovery returns nothing.

Each type shows whether it's a **live client** or **simulated (mock)**. A service registered against a type that has a live client (SendGrid, Twilio, Constant Contact, Telesign) runs on the mock until its required credentials are set, then the registry switches it to the live client automatically. Services can be **archived** (kept for history, removed from the registry) or **deleted** (only when they hold no consent history — the database blocks deleting a service whose removal would destroy consent records). Archived services are **hidden by default** — they drop out of the consent matrix and the services list but stay in every report; a *show archived* toggle (`?includeArchived=1`) reveals them.

Configuring a service also exposes a **Consent-check API keys** panel (ADR-0004): issue a per-system key (shown once), see each key's prefix / last-used / status, and revoke instantly. A sender uses the key to call `POST /api/v1/consent/check` before sending.

### Settings

**Admin → Settings** edits the runtime **operational policy** — consent-check posture (blocklist/allowlist) and rate limit, opt-in review trigger/TTL and separation-of-duties, sync-lag threshold, audit-retention windows, scheduled-job intervals, the default phone region, and the webhook timestamp-skew window. Values live in the `app_config` table and are read through the live `policy` object, so changes **apply immediately** (an interval change reloads the scheduler) and are audited.

The same screen carries a **Consent categories & opt-out cascade** card (§10): each service is tagged with a category (marketing / transactional / emergency — admin-**extensible**, so a future FCC-exempted class is a config change), and a category-to-category matrix (row = the category a STOP arrived on, column = where it propagates) governs the cascade, with an *Add a category* form. A **protected** category (e.g. emergency) is locked as never-a-target, so emergency notices are never suppressed; propagation is also **channel-scoped** — a phone opt-out never cascades onto an email service or vice versa. Categories can be **archived** (retired from new assignment, still honored for services already on them) or **deleted** (only when no service uses them — otherwise archive). This replaced the old single "propagate to all / a list of systems" knob — an opt-out now cascades only where the matrix (and the category the student actually opted out of) says it should.

Configuration splits into exactly two places, so every knob has one authoritative home:

- **UI-authoritative (operational policy)** — everything on this Settings screen. The **database wins**; the matching env var (in `.env.example`) only **seeds the initial default** on a fresh database and is ignored after that. Change these in the UI, not in `.env`.
- **Environment-authoritative** — **secrets** (`APP_SECRET`, `DATABASE_URL`, `OIDC_CLIENT_SECRET`, `METRICS_TOKEN`, `TWILIO_EVENTS_TOKEN`, `ALERT_WEBHOOK_URL`, bootstrap passwords), **infrastructure/boot** (`PORT`, `TRUST_PROXY`, `FORCE_HTTPS`, `REDIS_URL`, `WEBHOOK_PUBLIC_BASE`), **SSO** (`OIDC_*`, `SSO_JIT_ROLE`), the **login throttle** (`LOGIN_THROTTLE_*` — a sign-in security control kept off the app-editable surface), and **logging** (`LOG_LEVEL` / `LOG_FORMAT`, read before the database is available). These are deliberately **not** on the Settings screen — they're secrets, deployment topology, security controls, or needed before the DB is reachable. `.env.example` is organized into these same two sections with the rule stated at the top.

### Appearance

**Admin → Appearance** sets per-deployment branding — org name, browser-tab title, logo, favicon, and a full color palette (accent/links, background, header, text, cards, and the opt-in/opt-out/suppressed status colors) — stored in a single row and applied live across the console, the browser tab, and the sign-in screen. `GET /api/branding` is public (the login screen brands itself before auth); writes are admin-only (`PUT /api/branding`). Presentation only — never touched by a consent decision.

## Consent-check API (ADR-0004)

A sending service asks the hub, before sending, whether an identity is suppressed for a system/channel. It's machine-authed with a per-system key (not a session): issue one under **Admin → Services → Configure → Consent-check API keys** (shown once). Then:

```bash
curl -sS -X POST http://localhost:3000/api/v1/consent/check \
  -H "Authorization: Bearer oohk_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"system":"YOUR_SYSTEM_ID","channel":"sms","identities":["208-420-7280"]}'
```

The hub normalizes each identity (so raw or E.164 both work) and returns, per identity, `{decision, state, reason, as_of, advisory}`. `decision: "suppress"` is binding; `decision: "allow"` means only "no revocation on record" — **not** a consent grant (hence the advisory). The key must be scoped to `system` (else `403`) and `channel` must match the system's channel (else `400`); callers must **fail closed** — treat a `5xx`/timeout as `suppress`. Posture is blocklist by default (`unknown → allow`); set `CONSENT_CHECK_MODE=allowlist` to flip it (`unknown → suppress`).

A **reference sender integration** showing exactly this — a fail-closed consent gate plus a Twilio send wrapper for the custom texting app — is in [`optout-hub/examples/twilio-sender/`](optout-hub/examples/twilio-sender/) (`test/consent-gate.test.ts` covers the fail-closed rule).

## Reporting opt-outs to the hub

Besides the pre-send *check* above, a third-party app — or Twilio itself — can push consent events *into* the hub. Both paths below ingest exactly like a signed webhook, so propagation, precedence, and audit are identical; use them when a platform's own inbound webhook is owned by an app you can't repoint.

### Sender-reported — `POST /api/v1/consent/report`

The write counterpart to the check. When a sender's own app receives an opt-out it should feed to the hub — e.g. a Twilio **STOP** arriving at the custom texting app's *existing* inbound webhook — it reports it here **without repointing Twilio's webhook away from that app**. Same per-system key, scope, and rate limit as the check; the event ingests exactly like a hub webhook, so propagation, precedence, and audit are identical.

```bash
curl -sS -X POST http://localhost:3000/api/v1/consent/report \
  -H "Authorization: Bearer oohk_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"system":"YOUR_SYSTEM_ID","value":"208-420-7280","direction":"opt_out","source":"twilio STOP"}'
```

`value` is normalized (raw or E.164/email both work); `direction` is `opt_out` or `opt_in`; `occurred_at` (ISO-8601) and `source` are optional. The key must be scoped to `system` (else `403`). Returns `{ok, normalized, direction}`.

### Twilio Event Streams sink — `POST /api/webhooks/twilio-events/:systemId`

An **additive** way to receive Twilio opt-outs when a Messaging Service's *one* inbound webhook is already owned by a third-party app you can't repoint. A Twilio **Event Streams** subscription to `com.twilio.messaging.inbound-message.received` streams a copy of every inbound message (carrying `optOutType`) to this sink **in parallel** to that webhook — so a consumer's STOP reaches the hub without touching the third-party integration. One account-level subscription covers **every** Messaging Service. Unlike Twilio's messaging webhooks, Event Streams sinks aren't request-signed, so the route authenticates with a shared token (`TWILIO_EVENTS_TOKEN`) carried in the Sink URL `?token=` (or an `x-events-token` header); it returns `503` until the token is set. The CloudEvents payload (single object or batched array) is mapped by the same STOP/START logic as the webhook and deduped on `messageSid`.

**Routing.** Because the feed is account-level, each event is attributed to the hub system whose **Messaging Service SID** matches the payload's `messagingServiceSid` — so when each Messaging Service is registered as its own system (with its own category, §10), a marketing STOP and a transactional STOP land on the right systems. The `:systemId` in the URL is the **fallback** for a Messaging Service you haven't registered. This also lets you **mix delivery**: some Messaging Services can use their own per-service webhook while others rely on Event Streams — a message that arrives on both paths is deduped on `messageSid` and ingested once. Chosen over polling the Messages API (with Advanced Opt-Out, STOP replies don't appear in the SMS logs) and over a fan-out proxy (a single point of failure in front of the third-party app). Setup: create a Sink (type: Webhook) → `https://<hub>/api/webhooks/twilio-events/<system>?token=<TWILIO_EVENTS_TOKEN>` and a subscription to the inbound-message event.

## Authentication

Local users and SSO sit behind one identity table; credentials are sources that attach to it.

- **Local accounts:** scrypt-hashed passwords (Node built-in — zero native addons), failed-attempt lockout (5 tries → 15 min), admin-managed via the Users tab or `/api/users`.
- **SSO:** generic OIDC (authorization code + PKCE via `openid-client`) configured entirely by environment — works with Entra ID, Okta, Keycloak, or any compliant IdP. The completion path is protocol-agnostic (`(issuer, subject) → user`), so a SAML strategy for Shibboleth/InCommon campuses can be added later without schema changes. JIT provisioning lands first-time SSO users in the `viewer` role (configurable); optional `OIDC_ROLE_MAP` syncs IdP groups to roles on each login.
- **Sessions, not JWTs:** server-side sessions with sliding expiry. Disabling a user or changing a role revokes their sessions immediately.
- **RBAC:** `viewer < operator < approver < admin`. Reading requires viewer; recording events and running the reconciler require operator; deciding reviews requires approver; user management requires admin. Attribution (`actor`, `decided_by`) always comes from the session, never the request body.
- **Separation of duties:** with `INITIATOR_CANNOT_APPROVE=1`, the operator who manually entered an opt-in cannot decide its propagation review.
- **Bootstrap:** `npm run seed` creates `admin` / `op.demo` / `app.demo` with printed default passwords when no users exist. **Change them.**
- **Mock IdP:** `AUTH_DEV_MOCK_SSO=1` enables a built-in fake provider at `/auth/sso/dev/start` to exercise the JIT/link/role-mapping path without a real IdP (refuses to load in production).

All auth events — logins, failures, lockouts, user creation, role changes, password resets — land in the same `audit_log` as consent events: for a tool whose defensive posture is "we can prove who did what," authentication is part of the evidence.

## Deliberate PoC shortcuts

These are fine for proving the design and wrong for production:

- **No TLS termination.** Run behind a reverse proxy with TLS in any real deployment (set `TRUST_PROXY`). HTTPS is enforced in-app — plaintext requests are redirected to https and HSTS is sent (default on in production, `FORCE_HTTPS=1/0` overrides; requires `TRUST_PROXY`; `/healthz`/`/readyz` exempt). Security headers (CSP, X-Frame-Options, nosniff, Referrer-Policy) and CSRF are handled in-app; the session cookie is `HttpOnly; SameSite=Lax; Secure` (prod). See [SECURITY-REVIEW.md](SECURITY-REVIEW.md).
- **Mock adapters with synchronous echoes.** Real adapters are async: webhooks arrive late, polls batch, writes fail transiently. The event-time fold and the reconciler are built for that, but retry/backoff plumbing isn't here.
- **Live clients: outbound is live, inbound is wired but unproven end-to-end.** SendGrid and Twilio authenticate, discover topology, and write suppression — SendGrid via its Suppression API, Twilio via the **Consent Management API** (`POST accounts.twilio.com/v1/Consents/Bulk`), so the hub can now propagate an opt-out captured elsewhere to Twilio (needs a Messaging Service SID; the API is write-only, so Twilio state still can't be read back). Signature-verified inbound webhooks now exist too — Twilio STOP/START, the SendGrid Event Webhook, and the Telesign MO STOP/START callback map into `ingest` (`src/services/webhooks.ts`, routes `/api/webhooks/{twilio,sendgrid,telesign}/<system>`) — but the REST calls and webhook handlers have only been unit-tested at the pure mapping/signature layer; exercise them with real credentials and the platform-side webhook configured. For Twilio, the console can **auto-provision** that inbound webhook: **Admin → Services → configure a Twilio system → Provision inbound webhook** sets the Messaging Service's inbound URL to this hub (requires a Messaging Service SID and `WEBHOOK_PUBLIC_BASE`). When that webhook can't be repointed (a third-party app owns it), the **Twilio Event Streams sink** (`/api/webhooks/twilio-events/<system>`, see the Consent-check section) is the additive alternative. OAuth token refresh (for HubSpot/SFMC/Dynamics/Marketo) and moving non-secret connection params off the write-only credential store are both still open.
- **Phone normalization** uses `libphonenumber-js` (E.164 for any country; national-format numbers parse against `DEFAULT_PHONE_REGION`, default US). Acceptance is by structural possibility, so an opt-out is never dropped for a plausible number.
- **Single-process, no job queue.** The reconciler (`POST /api/reconcile`), the consent-check audit prune (`POST /api/consent-checks/prune`), the inbound poll (`POST /api/poll`), and the sync-lag alert scan (`POST /api/alerts/scan`) run on demand and, when enabled, on a built-in timer (`src/services/scheduler.ts` — off unless `RECONCILE_INTERVAL_MINUTES` / `PRUNE_INTERVAL_HOURS` / `POLL_INTERVAL_MINUTES` / `ALERT_SCAN_INTERVAL_MINUTES` are set). That scheduler is single-process: a multi-instance deployment must run these from one place (a leader or external cron) and still wants a real job queue plus event-driven triggers.
- **Observability.** `GET /healthz` (liveness) and `GET /readyz` (readiness — checks DB reachability) are public, unauthenticated, and dependency-light for load balancers / orchestrators. `GET /metrics` exposes Prometheus text-format gauges (identities, unconfirmed writes, open alerts, pending reviews, sync-lag breaches, recent consent-check decisions), gated by `METRICS_TOKEN` when set. Sync-lag alerting (§8.4) is wired: the scan reports opt-outs that have not converged within the threshold, writes each alert to the audit log, and — if `ALERT_WEBHOOK_URL` is set — POSTs a Slack/Teams-compatible payload. Operators get a **System** view in the console (sync-lag summary, open-liability counts, scheduler config with last-run times, an on-demand scan button, a per-platform inbound-status table — last inbound/last poll/30-day volume with per-system and all-services `Poll now` — and the health/metrics endpoint reference). Logs are structured (one JSON object per line, `LOG_FORMAT=pretty` for local dev), including a per-request access line with a correlation id (`X-Request-Id`), routed path, status, latency, actor, and ip. Request-level histograms (consent-check p99, etc.) for a Prometheus/Grafana stack remain the only open item.
- **Consent-check API hardening.** The batch-size cap (1..1000), per-key rate limiting, and the split-retention prune for the `consent_checks` audit table are all built (ADR-0004). The rate limiter is pluggable: an in-memory token bucket by default, or a shared Redis store (`REDIS_URL`) for multi-instance. The check-audit write is synchronous best-effort. Reference sender integrations exist (`examples/`), but no production sender is wired to call the API yet.
- **SERIAL ids, permissive CORS-free same-origin setup, no rate limiting.**

## Azure notes

The stack maps cleanly: Azure Database for PostgreSQL Flexible Server (set `DATABASE_URL` with `?sslmode=require`), and the Node app on App Service or Container Apps. Nothing here is Azure-specific, so the same artifacts deploy to any platform that runs Node and Postgres.
