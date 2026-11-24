# Production Readiness Checklist

> **This is the *status* tracker, not the setup instructions.** For the step-by-step
> path from a fresh copy to production, follow the **[Setup Guide](SETUP-GUIDE.md)**.
> This page tracks *how far along* each readiness item is.

Path from the current **proof of concept** to **testing/staging** and then **production**.
Grounded in the code as it exists today (see [QUICKSTART.md](QUICKSTART.md) "Deliberate PoC shortcuts" and the [README roadmap](README.md#roadmap)).

**Status legend:** ✅ done · 🟡 partial / designed-not-built · ⬜ not started

---

## 0. The core requirement — every service has a working enforcement path

A service "works" for consent when **all three legs of the enforcement triangle** that apply to it are real (DESIGN.md §8–§11):

| Leg | What it means | Applies to |
|---|---|---|
| **Outbound write** (hub pushes) | Hub writes opt-out/opt-in into the platform's suppression/subscription list via its API | Platforms with a caller-writable list (**pattern A**) |
| **Inbound ingest** (hub learns) | Hub receives the platform's own opt-out/opt-in events — by **webhook**, **poll**, or **export/import** — and folds them into consent state | **Every** platform |
| **Consent-check gate** (sender asks) | The sending code calls `POST /api/v1/consent/check` before sending and fails closed | **Withhold-only** platforms (**pattern B**), and any send path we control |

**Definition of done, per service:**
- **Pattern A (writable):** live outbound-write client **+** inbound ingest (webhook/poll/export) **+** credential/OAuth handling **+** integration test against a sandbox.
- **Pattern B (withhold-only):** inbound ingest **+** the sender wired to the consent-check gate **+** integration test.
- **Both patterns:** a per-service integration recipe added to [INTEGRATION.md](INTEGRATION.md) §11b (*Register → Inbound → Enforcement → Verify*) — an adapter isn't done until its recipe is documented.

### Per-service status (from `src/adapters/catalog.ts`)

Today **eight types have live clients** — SendGrid, Twilio, Constant Contact, Telesign, Amazon SNS, Amazon SES, Azure Communication Services, and Modern Campus Message (Signal Vine); the other 27 run on the **mock adapter** and have **no real opt-out path**. "Live" means the REST/signing client is built and unit-tested at the mapping/signature layer; end-to-end proof against the real platform with live credentials is still outstanding (see the "unproven" note below). the initial deployment targets are listed first.

| # | Service | Chan | Pattern | Inbound method | Outbound write | Inbound ingest | Consent gate | Overall |
|---|---|---|---|---|---|---|---|---|
| **Initial deployment targets** |
| 1 | Twilio (custom texting) | SMS | B withhold | webhook / Event Streams / report | 🟡 Consent API bulk write, unproven | 🟡 webhook + Event Streams + report, unproven | 🟡 reference sender | 🟡 |
| 2 | Telesign (Anthology Reach) | SMS | B withhold | webhook | n/a | 🟡 MO callback built, unproven | 🟡 consent gate | 🟡 |
| 3 | Constant Contact | Email | A writable | poll | 🟡 write built, unproven | 🟡 poller built, unproven | n/a | 🟡 (auth + OAuth refresh ✅ verified live; write/poll still need a real unsubscribe) |
| 4 | Email-to-SMS gateway | SMS | B withhold | export | n/a | ⬜ import | 🟡 reference sender | 🟡 |
| **SMS · CPaaS / programmable** |
| 5 | Vonage (Nexmo) | SMS | A | webhook | ⬜ | ⬜ | n/a | ⬜ |
| 6 | Sinch | SMS | A | webhook | ⬜ | ⬜ | n/a | ⬜ |
| 7 | Infobip | SMS | A | webhook | ⬜ | ⬜ | n/a | ⬜ |
| 8 | Bird (MessageBird) | SMS | A | webhook | ⬜ | ⬜ | n/a | ⬜ |
| 9 | Plivo | SMS | A | webhook | ⬜ | ⬜ | n/a | ⬜ |
| 10 | Telnyx | SMS | A | webhook | ⬜ | ⬜ | n/a | ⬜ |
| 11 | Bandwidth | SMS | A | webhook | ⬜ | ⬜ | n/a | ⬜ |
| 12 | Amazon SNS / EUM | SMS | A (opt-in write only) | poll/read | 🟡 opt-in write (`OptInPhoneNumber`), unproven | 🟡 opt-out read (`CheckIfPhoneNumberIsOptedOut`), unproven | n/a | 🟡 |
| 13 | Azure Communication | SMS | A | poll/read | 🟡 opt-out add / opt-in remove, unproven | 🟡 opt-out-list check, unproven | n/a | 🟡 |
| **SMS · campaign / business** |
| 14 | Attentive | SMS | A | webhook | ⬜ | ⬜ | n/a | ⬜ |
| 15 | Klaviyo | SMS/Email | A | webhook | ⬜ | ⬜ | n/a | ⬜ |
| 16 | EZ Texting | SMS | A | poll | ⬜ | ⬜ | n/a | ⬜ |
| 17 | SimpleTexting | SMS | A | webhook | ⬜ | ⬜ | n/a | ⬜ |
| 18 | SlickText | SMS | A | webhook | ⬜ | ⬜ | n/a | ⬜ |
| **SMS · withhold-only / vertical** |
| 19 | Mongoose Cadence | SMS | B | poll | n/a | ⬜ | ⬜ gate | ⬜ |
| 20 | Modern Campus Message | SMS | B | poll | 🟡 push via participants (unconfirmed) | 🟡 poll `contacts?active=false`, unproven | n/a (no send API) | 🟡 |
| **Email · marketing / ESP** |
| 21 | Mailchimp | Email | A | webhook | ⬜ | ⬜ | n/a | ⬜ |
| 22 | HubSpot | Email | A | webhook | ⬜ | ⬜ | n/a | ⬜ |
| 23 | ActiveCampaign | Email | A | webhook | ⬜ | ⬜ | n/a | ⬜ |
| 24 | Brevo (Sendinblue) | Email | A | webhook | ⬜ | ⬜ | n/a | ⬜ |
| 25 | MailerLite | Email | A | webhook | ⬜ | ⬜ | n/a | ⬜ |
| 26 | Mailjet | Email | A | webhook | ⬜ | ⬜ | n/a | ⬜ |
| 27 | Salesforce Marketing Cloud | Email | A | webhook | ⬜ | ⬜ | n/a | ⬜ |
| 28 | Adobe Marketo Engage | Email | A | poll | ⬜ | ⬜ | n/a | ⬜ |
| 29 | Dynamics 365 Journeys | Email | A | webhook | ⬜ | ⬜ | n/a | ⬜ |
| **Email · transactional / SMTP API** |
| 30 | Twilio SendGrid | Email | A | webhook | ✅ write suppression | 🟡 handler built, unproven | n/a | 🟡 |
| 31 | Amazon SES | Email | A | poll/read | 🟡 suppression add (opt-out) / remove (opt-in), unproven | 🟡 suppression-list read, unproven | n/a | 🟡 |
| 32 | Mailgun | Email | A | webhook | ⬜ | ⬜ | n/a | ⬜ |
| 33 | Postmark | Email | A | webhook | ⬜ | ⬜ | n/a | ⬜ |
| 34 | Mailchimp Transactional | Email | A (opt-out only) | webhook | ⬜ | ⬜ | n/a | ⬜ |
| 35 | Mock (demo) | — | — | — | — | — | — | ✅ (test only) |

> **"unproven"** = the client/handler code exists and is unit-tested at the mapping/signature layer, but has never run against the real platform with live credentials and the platform-side webhook configured.

### Cross-cutting enforcement machinery still to build

These are needed before the per-service work can be finished, because many services share them:

- ⬜ **Outbound-write clients** for every pattern-A platform (28 of them). Each follows the SendGrid shape: authenticate → write suppression/subscription → confirm. Prioritize by deployment usage.
- 🟡 **Poll-based ingestion runner** — ✅ built (`src/services/poller.ts` + scheduler `POLL_INTERVAL_MINUTES` + `POST /api/poll`, per-system cursor in `poll_state`, migration 012). It calls each poll-capable adapter's `pollOptOuts` and feeds events through `ingest`. Remaining: wire the other `poll` platforms' adapters (EZ Texting, Mongoose Cadence, Marketo) to it, and prove Constant Contact against a live account.
- ⬜ **Export/import ingestion** — a pipeline to ingest opt-out lists for `export` platforms (email-to-SMS gateway). No import path exists. *(Modern Campus Message, previously assumed `export`, is actually `poll`-capable via its API — `GET /v2/programs/{id}/contacts?active=false` — so it needs a Signal Vine adapter with HMAC signing, not a file import.)*
- 🟡 **Inbound webhook handlers + signature verification, per platform.** Twilio (STOP/START), SendGrid (event webhook), and Telesign (MO callback, HMAC-SHA256) exist; each remaining webhook platform still needs its own signature scheme and payload mapping. Two additional inbound paths sidestep the "one webhook per Messaging Service" limit: **Twilio Event Streams** (`POST /api/webhooks/twilio-events/<system>`, shared-token auth via `TWILIO_EVENTS_TOKEN`, CloudEvents payload with `optOutType`) and a **sender-reported** path (`POST /api/v1/consent/report`, per-system key) — both feed the same `ingest`, so a STOP still reaches the hub when the Messaging Service's own webhook is owned by a third-party app.
- ✅ **OAuth token refresh** — built for **Constant Contact** (refresh-on-401 with rotating-token persistence via `storeRotatedCredential`) and **verified live on your-hub.example.edu**: after fixing the refresh request to post form-urlencoded params (Okta E0000021), the adapter authenticates and **auto-refreshes unattended across a real ~24h key rotation** (Test connection stays green). Remaining: the same pattern for HubSpot, SFMC, Marketo, Dynamics as those adapters land.
- ⬜ **Sender consent-gate adoption in real senders** — reference gates exist (`examples/`), but the actual Twilio texting app and email-to-SMS sender must adopt them (with the hub's exact identity normalization).
- ✅ **Message-category opt-out cascade** — built (`src/services/categories.ts` + `test/categories.test.ts`, migrations 016–017). Replaces the flat "all / subset of system ids" propagation scope: each service is tagged with a category and an opt-out cascades per an admin-editable **category→category matrix** — so a marketing STOP need not silence transactional or emergency mail. **Protected** categories (emergency) are never a cascade target (enforced in code, 47 C.F.R. § 64.1200(f)(4)); propagation is **channel-scoped** (no phone↔email leakage); categories are data-driven with an **archive/delete lifecycle**. Grounds the enforcement decision in the federal research. Remaining: exercise the write-side of a cascade end-to-end per platform.

---

## 1. Security hardening (blockers for any internet-facing deployment)

- 🟡 **TLS termination** — the app serves plain HTTP and expects a reverse proxy / load balancer to terminate TLS. HTTPS is now **enforced in-app**: with `TRUST_PROXY` set, plaintext requests are 308-redirected to https and HSTS is sent (on by default in production; `FORCE_HTTPS=1/0` overrides; `/healthz` and `/readyz` exempt). Proxy/TLS wiring (incl. **`TRUST_PROXY`** — required so `req.ip` is the real client, not `127.0.0.1`, and so the per-IP login throttle works — plus a sample nginx/Caddy config that blocks `.env`/dotfile scanner probes) is documented in **[DEPLOYMENT.md](DEPLOYMENT.md)**. Remaining: stand up the actual TLS terminator + certificates.
- ✅ **CSRF protection** on state-changing console routes — per-session synchronizer token (`X-CSRF-Token`) required on cookie-session mutating requests, on top of the `HttpOnly; SameSite=Lax` cookie; machine/API-key and webhook routes are exempt (no session).
- 🟡 **Secrets management** — ✅ secrets (`APP_SECRET`, `DATABASE_URL`, `OIDC_CLIENT_SECRET`) resolve from mounted files via `<NAME>_FILE` (provider-agnostic: Docker/K8s secrets, Azure Key Vault CSI, Vault), production **refuses to boot** on a missing/weak/dev-default `APP_SECRET`, and key rotation is real (`npm run reencrypt` re-encrypts the credential store from `APP_SECRET_OLD` → `APP_SECRET`). Remaining: wire the deployment to an actual secret store and schedule rotation.
- 🟡 **Rate-limit store** — ✅ pluggable behind a `RateLimitStore` interface: in-memory default (single instance), plus an optional Redis store (`ratelimit-redis.ts`, atomic Lua token bucket) enabled by `REDIS_URL` so the limit holds across instances. Remaining: `npm install redis`, point `REDIS_URL` at your Redis, and validate the Redis path against a live server (the Lua mirrors the tested core, but the Redis plumbing isn't in CI).
- ✅ **Session store** — already server-side in PostgreSQL (`sessions` table), so it is shared across instances as-is. (Follow-up: review cookie flags — Secure is set in production; consider HttpOnly/SameSite hardening.)
- ⬜ **Webhook endpoint protection** — signature verification is required and present for Twilio/SendGrid; add replay protection (timestamp/nonce) and per-endpoint rate limiting; confirm `WEBHOOK_PUBLIC_BASE` behind the proxy.
- 🟡 **Bootstrap credentials** — the seed now **requires** `*_BOOTSTRAP_PASSWORD` env vars under `NODE_ENV=production` (refuses built-in defaults, doesn't echo the password); dev keeps convenience defaults. Rotation/disable procedures are in [RUNBOOK-key-and-credential-rotation.md](RUNBOOK-key-and-credential-rotation.md). Operationally, set strong values and disable the demo accounts you don't need.
- ✅ **Per-IP login throttle** — repeated failed sign-ins from one address are blocked (`LOGIN_THROTTLE_*`, default 10 failures / 15 min → 15 min block), on top of the per-account lockout. Only failures count; a success resets, so legitimate users are unaffected.
- 🟡 **Security review** of the auth, credential-store, and webhook surfaces — ✅ done ([SECURITY-REVIEW.md](SECURITY-REVIEW.md)): no Critical/High findings; Medium/Low hardening (security headers, error-message sanitization, `x-powered-by`, `trust proxy`) fixed. ✅ Webhook replay protection, ✅ per-IP login throttle + credential hygiene, and ✅ CSP tightened to `script-src 'self'` (no `'unsafe-inline'`) are all done. Still to do: **dependency & container scanning** in CI.
- ⬜ **CORS / same-origin** review; **security headers** (CSP, HSTS, X-Content-Type-Options).

## 2. Operational hardening (roadmap item 9)

- 🟡 **Scheduled reconciliation** — a built-in timer runs it (`src/services/scheduler.ts`, `RECONCILE_INTERVAL_MINUTES`), in addition to `POST /api/reconcile`. Remaining: event-driven triggers, and leader-election/external cron for multi-instance (the timer is single-process).
- 🟡 **Scheduled retention prunes** — a built-in timer (`PRUNE_INTERVAL_HOURS`) runs both the consent-check prune (`POST /api/consent-checks/prune`) and the operational `audit_log` prune (`POST /api/audit-log/prune`; default 14-day window, compliance actions exempt), each also runnable from an admin card. Same multi-instance caveat.
- 🟡 **Sync-lag alerting** — a built-in timer (`ALERT_SCAN_INTERVAL_MINUTES`) scans for opt-outs not converged within the threshold and raises an alert to the audit log and, if `ALERT_WEBHOOK_URL` is set, a Slack/Teams-compatible webhook; also runnable via `POST /api/alerts/scan`. The 10-business-day regulatory ceiling is flagged as a `breach`. Remaining: route breach-level alerts to a paging channel, and the multi-instance caveat (single-process timer).
- ⬜ **Retry/backoff** for async adapter writes (webhooks arrive late, writes fail transiently); today writes are best-effort with no retry queue.
- ⬜ **Job queue / worker** — the app is single-process; introduce a queue for reconciliation, polling, writes, and the prune.
- 🟡 **Observability** — `GET /healthz` (liveness), `GET /readyz` (readiness, DB-reachability), and `GET /metrics` (Prometheus gauges: identities, unconfirmed writes, open alerts, pending reviews, sync-lag breaches, recent consent-check decisions; `METRICS_TOKEN`-gated) endpoints exist, plus an operator **System** view in the console (sync-lag, open-liability, scheduler status, and per-platform inbound status with on-demand poll). Logs are structured (JSON lines; per-request access log with correlation id, path, status, latency, actor, ip; `LOG_LEVEL`/`LOG_FORMAT`). Remaining: request-level histograms (consent-check p99, reconciler throughput, webhook success rate), external dashboards, and on-call/paging integration.
- 🟡 **Backups & DR** for PostgreSQL; tested restore; retention aligned with the audit windows. ✅ Runbook written ([RUNBOOK-backup-and-dr.md](RUNBOOK-backup-and-dr.md): nightly `pg_dump`, the **`APP_SECRET` capture requirement** without which credentials can't be decrypted, restore steps, a tested-restore drill, and DR scenarios). Remaining: **implement** the scheduled backups + off-host encrypted storage + quarterly restore drill on your-hub.example.edu.
- ✅ **Process supervision (fail-fast)** — the app logs a fault synchronously (crash tracer) and **exits(1)** on an uncaught exception / unhandled rejection rather than serving from an undefined state. ✅ in code, and the process now runs under a restart supervisor (Windows Service via NSSM on your-hub.example.edu, with restart-on-exit + crash-loop backoff) — documented in [DEPLOYMENT.md](DEPLOYMENT.md) "Process supervision." Remaining for other environments: a systemd `Restart=always` unit (or pm2) when the app moves to its Linux production host.
- ⬜ **High availability** — once the in-process limiter/caches are externalized, run ≥2 instances behind a load balancer.

## 3. Data & correctness

- 🟡 **Phone normalization** — ✅ the hub normalizer uses `libphonenumber-js` (E.164, `DEFAULT_PHONE_REGION`, `isPossible` acceptance). Remaining: the reference sender consent-gate still ships a lightweight `defaultNormalize`; production senders must use the **same** libphonenumber normalization for cache-key parity (ADR-0004).
- ⬜ **Migration/rollback strategy** — forward-only migrations exist; add a rollback/runbook and a staging dry-run.
- 🟡 **Idempotency/dedup at scale** — echo suppression is now idempotent to redelivery: an inbound event bearing one of our `sync_origin_key`s is treated as our own echo regardless of `confirmed_at`, so an at-least-once webhook redelivery can't be re-recorded as a fresh consumer opt-out (#91). Remaining: validate event dedup + echo suppression under real webhook volume and retries.
- ⬜ **Identity edge cases** — international numbers, plus-addressing, role addresses, normalization collisions.

## 4. Testing & QA

- ⬜ **Integration/e2e per live adapter** — real sandbox credentials, real outbound write, real inbound webhook end-to-end (currently only pure-unit mapping/signature tests).
- ⬜ **Webhook signature tests** with real captured payloads per platform.
- 🟡 **Load/performance testing** — ✅ tooling shipped: a dependency-free `loadtest/` kit (scale seeder + closed-loop generator; check/report/mixed modes; ramp + p99-SLO verdict) with methodology in [PERFORMANCE.md](optout-hub/PERFORMANCE.md), and the DB pool is now tunable via `PG_POOL_MAX` (#92). Remaining: the actual **scaled run against your-hub.example.edu** (consent-check p99 under campaign fan-out; reconciler at full identity×system scale) and a DB indexing review. Building the kit already surfaced two findings (documented in PERFORMANCE.md): the pool defaulted to 10, and every consent-check writes `last_used_at` on the key row (read path is a write; contends under a single high-volume key).
- ✅ **DB-backed path coverage** — an integration harness (`test/integration/`, `npm run test:integration`) exercises `checkConsent`, ingest + propagation/cascade, reconciler backfill, the approval workflow (incl. separation-of-duties + explicit-opt-out precedence), reporting, and key API routes against a throwaway Postgres, with a `*_test`-name safety rail and graceful skip when no DB is present (#91). Remaining: the `listSuppressions` feed is still only manually checked.
- ⬜ **UAT** — the deploying organization's staff walk the console workflows (matrix, approvals, alerts, reports, service config).
- ⬜ **Failure-mode drills** — hub outage (sender fail-closed / fail-to-cache), DB failover, webhook storm, bad credentials.

## 5. Compliance & legal

- ⬜ **Retention windows confirmed with counsel** — suppress ≈ 4 yr, allow/error ≈ 30–90 d are engineering defaults (ADR-0004 §7); confirm before go-live and set the env knobs.
- ⬜ **FCC "revoke-all" rule** (effective Jan 31, 2027) — verify cross-channel revocation propagation matches the final rule.
- ⬜ **Audit completeness review** — every consent decision, override, and admin action is captured and immutable; evidence supports the § 227(c)(5) affirmative defense.
- ⬜ **Data-subject requests** — FERPA/privacy handling for access/deletion; how consent history interacts with deletion.
- ⬜ **Legal sign-off** and the non-legal-advice disclaimer reviewed.

## 6. Deployment & infrastructure

- 🟡 **CI/CD** — a CI workflow exists (`.github/workflows/ci.yml`: typecheck + full test suite + migrate-against-Postgres, plus an advisory `npm audit`), but CI gating is **currently disabled** — the merge-blocking ruleset was removed, so PRs merge on **local verification** (`npx tsc --noEmit` + `npm test`) for now. Remaining: re-enable CI and require the check for merge (branch protection), and add deploy automation.
- ⬜ **Environment config** — env → secrets manager; per-env (dev/staging/prod) configuration and the policy knobs (`src/core/policy.ts`).
- ⬜ **Containerization/orchestration** and infra-as-code.
- ⬜ **Staging environment** that mirrors production (TLS, secrets, live-sandbox adapters).
- ⬜ **Runbooks** — deploy, rollback, incident response, on-call rotation, webhook re-registration.

## 7. UI / UX

- 🟡 **Branded restyle (default theme)** — shell + matrix + section headers + login done ([PR #24]); remaining tabs already inherit the new components. Finish per-tab polish.
- ✅ **Navigation consolidated** — the top nav collapses to five items (**Consent matrix**, **Approvals**, **Operations ▾**, **Reports ▾**, **Admin ▾**); read-only/compliance views (Reports, Audit log, Topology) and operator tools (Simulate event, Alerts, System) are grouped into dropdowns mirroring the Admin menu. RBAC unchanged — System stays operator-gated, Admin admin-only.
- ⬜ **Accessibility audit** (WCAG 2.1 AA) — contrast (gold is accent-only), keyboard nav, screen-reader labels. *(Re-check dropdown keyboard nav / `aria-expanded` on the grouped menus.)*
- ⬜ **Per-service config UX** — the register/connect/discover flow works for the live adapters; validate it as each new adapter lands.
- ⬜ **Responsive/mobile** review of the console.

---

## Suggested phasing

**Phase 0 — Pre-testing blockers (must-do before staging):**
TLS + reverse proxy · ~~secrets management~~ (file-based + fail-fast + rotation shipped; wire to a real store) · ~~scheduled reconciliation + prune~~ · shared rate-limit store (sessions already DB-backed) · ~~libphonenumber~~ · CI + staging env · security review of auth/credential/webhook surfaces.

**Phase 1 — Testing/staging (per-service, prioritized to the deployment's stack):**
Land the four **initial-target** services end-to-end first (Twilio custom, Telesign, Constant Contact, email-to-SMS gateway) — each with outbound write (where writable), inbound ingest (webhook/poll/export), OAuth refresh where needed, and integration tests. Wire the real senders to the consent gate. Prove Twilio + SendGrid against live sandboxes. Then expand to the platforms the deployment actually uses.

**Phase 2 — Production:**
Compliance/legal sign-off · retention windows confirmed · monitoring/alerting live · backups/DR tested · HA (≥2 instances) · runbooks · UAT passed · remaining adapters delivered as needed.

---

*Living document — edit as items land. Per-service statuses reflect `src/adapters/catalog.ts` and `src/adapters/registry.ts` at the time of writing (live clients: `sendgrid`, `twilio`, `constant_contact`, `telesign`, `amazon_sns`, `amazon_ses`, `azure_communication`, `modern_campus_message`).*
