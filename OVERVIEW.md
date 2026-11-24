# Universal Opt-Out / Consent Hub — Project Overview

*A shareable, high-level summary of what the Consent Hub does, how it is managed,
and the security and compliance measures built into it. For the engineering
detail, see `DESIGN.md`, `SECURITY-REVIEW.md`, and `PRODUCTION-READINESS.md`.*

---

## In one paragraph

The Consent Hub keeps a person's messaging opt-out/opt-in choices **consistent
across every SMS and email platform the institution uses**: a STOP, unsubscribe, or
removal request is recorded once and **propagated everywhere**, giving one auditable
source of truth for consent. *(For the full problem statement and how it works, see
the [README](README.md); this document goes deeper on capabilities, administration,
security, and compliance for evaluators.)*

---

## What it does — core capabilities

- **Universal opt-out propagation, scoped by message category.** An opt-out
  captured on any connected platform is applied to the others automatically, per a
  configurable **message-category cascade matrix** — so a marketing opt-out need
  not silence transactional or emergency messaging. Categories marked **protected**
  (e.g. emergency/safety) are **never suppressed**, so critical notices always
  reach students; the category set is admin-editable as regulations evolve.

- **Guarded opt-in propagation.** Re-subscribing is treated more carefully than
  opting out. An opt-in can trigger a **review** before it is pushed to other
  systems, with a **separation-of-duties** rule (the person who initiates a change
  cannot also approve it) and a built-in **precedence engine** that refuses to
  re-enable a system where the person has an explicit opt-out on file.

- **Consent-check API for senders.** Before a sending system messages someone, it
  can ask the hub "is this person OK to contact on this channel?" The check is
  **fail-closed** (a system error suppresses the send rather than risking an
  unwanted message) and supports two postures: *blocklist* (send unless a
  revocation is on file) or *allowlist* (send only with a positive opt-in).

- **Inbound capture from real platforms.** The hub ingests consent changes as they
  happen — via **signed webhooks** (e.g. Twilio STOP/START, SendGrid unsubscribe
  events, Telesign mobile-originated STOP) and via **scheduled polling** for
  platforms that have no webhook (e.g. Constant Contact). Where a platform allows
  only one inbound webhook and another application already owns it, the hub offers
  **additive paths** that capture the opt-out without disturbing that integration —
  a Twilio **Event Streams** subscription and a lightweight **report** call a sending
  app can make when it receives a STOP itself.

- **Reconciliation.** A background loop periodically compares what each platform
  reports against what the hub believes, **corrects drift** where it safely can,
  and raises an **alert** for divergence a human needs to look at (for example, a
  platform showing an opt-out the hub never received).

- **Sync-lag monitoring.** The hub tracks how long an opt-out takes to converge
  everywhere and **alerts** when a propagation exceeds the configured threshold —
  with the regulatory ceiling flagged as a hard breach.

- **Reporting.** Built-in reports cover an individual's full consent record, open
  liabilities (unconfirmed writes, unresolved alerts, aging reviews), activity
  volume, sync-lag, and a complete audit trail.

- **Broad platform catalog.** The hub ships with a catalog of **35 SMS/email
  platform types**. Seven have **live API integrations** today — Twilio, SendGrid,
  Constant Contact, Telesign, Amazon SNS (SMS), Amazon SES (email), and Azure
  Communication Services (SMS) — and the rest run on a faithful simulator until a
  live client is built, so the full workflow can be exercised end to end now.

---

## How it works (at a glance)

- **One record of truth.** Every consent change is stored as an event; the current
  state of each person on each system is a recomputable projection of those events.
  This makes the history **auditable and replayable** rather than a mutable value
  that can be silently overwritten.

- **Adapters.** Each platform is reached through an adapter that implements a common
  contract (observe state, write a correction where the platform allows it, verify
  connectivity, discover the platform's sending groups). Platforms differ — some
  expose a writable suppression list, others (like Twilio and Telesign) only let you
  *withhold* sends and manage STOP on their own side — and the hub models those
  differences explicitly rather than pretending they are the same.

- **Topology awareness, kept separate.** The hub can discover a platform's structure
  (sender pools, lists, codes) and use it for **reporting and attribution only** — it
  never lets a platform's grouping override a person's consent decision.

---

## Backend management & administration

The hub is administered through a **web console** with role-appropriate access:

- **Services.** Register a platform from the catalog, store its credentials, test the
  connection, and discover its sending structure. Services can be archived (kept for
  history) or deleted (only when they hold no consent history).

- **Users & roles.** Four roles — **viewer, operator, approver, admin** — scope what
  each person can see and do. Admin-only screens are hidden from everyone else.

- **Settings.** Operational policy is **stored in the database and editable in the
  console** — consent posture, the opt-out cascade matrix by message category, review triggers and time-to-live,
  retention windows, scheduled-job intervals, alert thresholds, and more. Changes
  **take effect immediately** and are **audited**; the database is authoritative, so
  configuration is not scattered across environment files.

- **Appearance.** Institutional branding (logo, colors, name) is configurable so the
  console reflects the deploying organization.

- **Scheduled maintenance.** Reconciliation, inbound polling, audit-retention
  pruning, and sync-lag alert scans run on configurable timers, each also runnable
  on demand.

- **Operator visibility.** A **System** view surfaces live health: current sync-lag
  breaches, open liabilities, scheduler status with last-run times, and a
  per-platform inbound status (last webhook / last poll, with an on-demand poll).

- **Observability for operations teams.** Standard **health and readiness endpoints**
  for load balancers, a **Prometheus-compatible metrics endpoint**, and **structured
  (JSON) logs** with a request-correlation id integrate cleanly with common
  monitoring stacks.

---

## Security measures

Security was treated as a first-class requirement, not an afterthought. A formal
security review of the authentication, credential-storage, and webhook surfaces
found **no Critical or High findings**; the lower-severity items have since been
closed.

- **Authentication.** Local accounts use a modern password hash (scrypt, OWASP
  parameters); single sign-on via **OIDC/SSO** is supported. Sign-in is protected by
  a **per-account lockout** and a **per-IP throttle** against credential-stuffing,
  tuned so legitimate users are unaffected.

- **Access control & separation of duties.** Role-based access throughout, plus the
  explicit rule that the initiator of a consent change cannot approve its
  propagation.

- **Credential protection.** Platform credentials are **encrypted at rest**
  (AES-256-GCM) under a key derived from an application secret, are **never displayed
  back** (the console shows only which keys are set and a last-four hint), and support
  **unattended key rotation**. Core secrets (application key, database, SSO) live in
  the environment or mounted secret files — **never in the database**.

- **Web-app hardening.** **CSRF protection** on all state-changing console actions, a
  strict **Content-Security-Policy** (no inline scripts), plus HSTS (in production),
  clickjacking protection, MIME-sniffing protection, and a restrictive referrer
  policy. The console uses **no third-party/CDN assets** — everything is served
  locally.

- **Webhook integrity.** Every inbound webhook is **cryptographically verified**
  (HMAC or ECDSA signatures per platform) and protected against **replay** (per-event
  de-duplication plus signed-timestamp freshness), so a forged or replayed callback
  cannot inject a false consent change.

- **Fail-closed consent decisions.** When the hub cannot determine a person's status,
  it defaults to the safe outcome (suppress), so an outage never causes an unwanted
  message.

- **Auditability & retention.** The consent event history is **append-only** and
  consent-decision evidence is **immutable**, retained on **configurable, statute-aware
  schedules**. The operational activity log is pruned on a configurable window to bound
  growth, with **compliance-relevant actions** (approval decisions, configuration changes)
  kept indefinitely.

- **Operational runbook.** Documented procedures exist for rotating the encryption
  key and the bootstrap/administrative credentials.

---

## Compliance posture

The design is oriented toward the regulatory obligations that make consent
synchronization matter — notably the **FCC/TCPA** expectation that a revocation is
honored across related channels, and **CAN-SPAM** unsubscribe handling. Work is
planned (and tracked) to complete a **HECVAT 4.x** security assessment, an
**accessibility audit and VPAT**, formal **data-subject request handling (privacy /
FERPA)**, and confirmation of retention windows with counsel.

---

## Technology & deployment

- **Stack:** Node.js, TypeScript, Express, and PostgreSQL — a small, widely-supported
  footprint with no exotic dependencies.
- **Portability:** nothing is vendor-locked; it deploys to Azure (App Service or
  Container Apps + Azure Database for PostgreSQL) or any platform that runs Node and
  Postgres.
- **Self-contained:** the console ships as local assets with no external content
  dependencies.

---

## Status

The Consent Hub is a **working proof of concept advancing toward production**. The
full consent workflow — propagation, guarded opt-in review, reconciliation, the
consent-check API, inbound webhooks and polling, reporting, and observability — is
implemented and exercised end to end. Remaining work is tracked as a formal
path-to-production plan: additional live platform integrations, high-availability
deployment, backups/DR, integration testing against live accounts, and the
compliance/accessibility assessments noted above.
