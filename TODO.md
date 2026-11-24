# TODO

Working checklist for the path to production. The detailed rationale and the
per-service enforcement matrix live in [PRODUCTION-READINESS.md](PRODUCTION-READINESS.md);
this is the quick, check-off-able view.

## ✅ Done
- [x] Scheduled reconciliation + retention prunes (consent-check + operational audit_log, in-process scheduler)
- [x] Phone normalization via `libphonenumber-js`
- [x] Secrets management — file-based (`<NAME>_FILE`), fail-fast in production, key rotation (`npm run reencrypt`)
- [x] Poll-based inbound ingestion + per-system cursor
- [x] OAuth token refresh + rotation pattern (Constant Contact)
- [x] console UI button-contrast fix
- [x] **8 live services**: SendGrid, Twilio, Constant Contact, Telesign, Amazon SNS, Amazon SES, Azure Communication Services, Modern Campus Message (Signal Vine) — all three enforcement shapes have templates
- [x] **Message-category opt-out cascade** — admin-editable category→category matrix (replaces the flat scope knob), emergency never suppressed, channel-scoped, archive/delete lifecycle (migrations 016–017)
- [x] **Twilio inbound** — Event Streams sink routed by Messaging Service SID + sender-reported opt-outs (`POST /api/v1/consent/report`)
- [x] **Test coverage** — pure-logic unit tests for the approval/ingest decisions (#90) + an **integration harness** (`npm run test:integration`) exercising DB-backed ingest/cascade, reconciler backfill, approvals, consent-check, reporting, and key API routes against a throwaway Postgres (#91)
- [x] **Load-testing kit** — dependency-free seeder + closed-loop generator + [PERFORMANCE.md](optout-hub/PERFORMANCE.md) (#92); DB pool size now tunable via `PG_POOL_MAX`

## 🔴 Phase 0 — pre-testing blockers
- [ ] Shared rate-limit store (Redis-pluggable) — unblocks multi-instance / HA (sessions are already DB-backed)
- [ ] TLS termination + reverse-proxy deployment — *guidance written ([DEPLOYMENT.md](DEPLOYMENT.md): `TRUST_PROXY`, nginx/Caddy sample, dotfile-probe blocking); actual terminator + certs still to stand up*
- [x] CSRF protection on state-changing console routes (per-session token + SameSite=Lax)
- [x] CI workflow authored (GitHub Actions: typecheck + tests + migrate + npm audit) — but **currently disabled**; PRs merge on local verification (`tsc` + `npm test`)
- [ ] Re-enable CI + require it for merge (branch protection); deploy automation + a staging environment
- [x] Security review of auth / credential-store / webhook surfaces (SECURITY-REVIEW.md — no Critical/High)
- [x] Security headers (CSP, HSTS, X-Frame-Options, nosniff) + x-powered-by off + trust proxy
- [x] Webhook replay protection (event-id dedup + signed-timestamp freshness)
- [x] Per-IP login throttle (`LOGIN_THROTTLE_*`) + bootstrap-password hygiene in prod
- [x] Tighten CSP — `script-src 'self'` (external app.js + delegated handlers, no 'unsafe-inline')
- [ ] Dependency scanning (npm audit) in CI

## 🟡 Phase 1 — per-service coverage (28 of 35 still on the mock)
- [ ] eRezLife texting — *blocked: waiting on docs*
- [ ] Add "used by Augusoft Lumens" note to the `modern_campus_message` entry *(Lumens already covered)*
- [ ] Mailchimp, HubSpot (writable + webhook ESPs)
- [ ] Vonage, Sinch (CPaaS SMS)
- [ ] Outbound-write clients for the remaining pattern-A platforms
- [ ] OAuth refresh for HubSpot / SFMC / Marketo / Dynamics
- [ ] Export-based ingestion (Modern Campus, email-to-SMS gateway)
- [ ] Wire the reference consent-gate into the real production senders

## 🟢 Operational hardening
- [x] Sync-lag alerting / monitoring (scheduled scan → audit + optional webhook; `POST /api/alerts/scan`)
- [ ] Retry/backoff for async adapter writes
- [ ] Job queue for scheduled work
- [x] Observability — health checks (`/healthz`, `/readyz`), `/metrics`, operator System view, and structured logging done; request-level histograms (Prometheus/Grafana) still open
- [ ] Backups / DR for PostgreSQL
- [x] Surface `POST /api/poll` + last-inbound / last-poll status per platform (System view: inbound-status table, per-system + all `Poll now`)

## 📋 Phase 2 — compliance & testing
- [ ] Retention windows confirmed with counsel
- [ ] FCC "revoke-all" rule coverage verified — effective 2027-01-31 (delayed twice; may be narrowed/eliminated before then — see the research briefing)
- [ ] Integration / e2e tests per adapter with real sandbox credentials *(distinct from the mock-backed harness above)*
- [ ] Load / performance testing at scale — *tooling shipped (`loadtest/` kit + PERFORMANCE.md); scaled reference run against your-hub.example.edu (consent-check p99, reconciler at scale) still to do*
- [ ] UAT with the deploying organization's staff
- [ ] VPAT (needs an accessibility audit)
- [ ] HECVAT **4.1.5** (unified workbook, on-premise scoping) — *each deployer completes the official EDUCAUSE workbook with their org-specific answers* (there is no 4.2)

## ⏳ Waiting on the deployer
- [ ] eRezLife texting documentation
- [ ] Retention-window sign-off from counsel
