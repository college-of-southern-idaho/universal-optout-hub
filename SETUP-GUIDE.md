# Setup Guide — Consent Hub

The single, linear path from a fresh copy of the software to a supported production
deployment for your organization. Work through the stages **in order**; each lists the
concrete steps and a **Done when** line that tells you it's safe to move on. Where a
stage needs depth, it points to **one** reference doc — you shouldn't have to hunt
across files to figure out what comes next.

**Before you start:** run it locally once via the **[Quickstart](QUICKSTART.md)** to
see the console and the consent model in action, then come back here. Track progress
against the **[Production Readiness](PRODUCTION-READINESS.md)** checklist as you go —
that's the *status* view; this is the *instructions*.

This guide is tool- and vendor-neutral: it names *what* to do and points to the
reference docs — **[Configuration](CONFIGURATION.md)**, **[Deployment](DEPLOYMENT.md)**,
**[Integration](INTEGRATION.md)**, and the runbooks — for the *how* on your platform.

---

## The core idea you are building toward

A messaging service honors consent only when the **three legs of the enforcement
triangle** that apply to it are real:

1. **Outbound write** — the hub writes an opt-out/opt-in into the platform's own
   suppression/subscription list (only for platforms whose API allows it).
2. **Inbound ingest** — the hub learns about opt-outs the platform receives itself,
   by webhook, scheduled poll, or file export/import.
3. **Consent-check gate** — the sending code asks the hub *"may I contact this
   person?"* before every send, and does not send if the answer is *suppress*.

Every stage below exists to make that triangle true for each service, on a host you
can operate and defend. A service is not "done" until its applicable legs are live
**and proven against the real platform** — not just unit-tested.

---

## Stage 1 — Inventory the messaging services

You cannot enforce consent on a channel you do not know exists.

1. List every system that sends SMS or email to your recipients — marketing, ESPs,
   CPaaS, transactional/SMTP APIs, and vendor products that send on your behalf.
2. For each, record: the platform, who owns the account (you or a vendor), the
   sending domain/numbers, and whether its API allows writing to a suppression list
   (**writable**) or only withholding sends (**withhold-only**).
3. Prioritize. Pick a small first wave (2–4 services) to launch with; the rest are
   added later.

**Done when:** you have a written service register with an owner and a pattern
(writable / withhold-only) for every sender, and a named first wave.

---

## Stage 2 — Stand up the production host

Move off any test/proof-of-concept box. Production needs infrastructure a
test instance does not.

1. **Provision a host** for the application and a **PostgreSQL** database.
2. **TLS termination** — put a reverse proxy or load balancer in front that holds a
   valid certificate and forwards to the app as plain HTTP. Add the certificate to
   **expiry monitoring** so a renewal never lapses (an expired cert plus HSTS is a
   hard outage). See `DEPLOYMENT.md` → *Edge hardening*.
3. **Tell the app it is behind a proxy** — set `TRUST_PROXY` so it sees the real
   client IP and the real HTTPS scheme (the HTTPS redirect, HSTS, and the login
   throttle all depend on this).
4. **Process supervision** — run the app under a supervisor that restarts it
   (Windows Service/NSSM/WinSW, systemd `Restart=always`, or pm2). The app is
   fail-fast: it exits on an unhandled fault and relies on the supervisor to bring
   it back. See `DEPLOYMENT.md` → *Process supervision*.
5. **Secrets store** — supply `APP_SECRET`, `DATABASE_URL`, and OIDC secrets from a
   real secret store (each is resolvable from a mounted file via `<NAME>_FILE`).
   Record `APP_SECRET` somewhere recoverable — without it the stored credentials
   cannot be decrypted.
6. **Edge hardening** — enforce HTTP→HTTPS redirect, block or token-gate `/metrics`,
   and strip server-fingerprint headers at the proxy (`DEPLOYMENT.md`).

**Done when:** the app is reachable only over HTTPS on its own domain, restarts by
itself after a kill, boots only with a strong `APP_SECRET` from your secret store,
and `/healthz` and `/readyz` both return healthy.

---

## Stage 3 — Configure and initialize the application

1. **Run database migrations** to create the schema.
2. **Set strong bootstrap credentials** (the seed refuses built-in defaults in
   production) and disable any demo accounts you do not need.
3. **Set the policy knobs** for your environment: default phone region, consent
   retention windows, the message-category cascade matrix, and the scheduler
   intervals (reconcile, poll, prune, alert scan).
4. **Keep outbound writes off until you are ready.** Leave the outbound-write kill
   switch disabled while you validate, so the hub records consent internally without
   pushing to live platforms. Turn it on per service in Stage 4.

> **Details:** every environment variable and policy knob — names, defaults, and
> which live in the database vs. the environment — is in **[Configuration](CONFIGURATION.md)**.

**Done when:** you can sign in to the console with a strong account, the schema is
migrated, and the app is running in its intended configuration with outbound writes
still gated.

---

## Stage 4 — Connect and prove each first-wave service

Do this **one service at a time**. For each service in your first wave, complete the
legs of the triangle that apply to it, then prove them end-to-end against the real
platform. Follow the per-service recipe in `INTEGRATION.md` and the vendor one-pagers.

For each service:

1. **Register** the service in the hub and issue its credentials (system id, service
   API key, and a webhook/stream token where used).
2. **Inbound ingest** — configure the platform to deliver its opt-out events to the
   hub (webhook, event stream, scheduled poll, or file import), and confirm a real
   opt-out on the platform arrives and is recorded.
3. **Outbound write** (writable platforms only) — enable outbound writes for this
   service and confirm the hub can write a suppression/subscription into the
   platform and read back confirmation.
4. **Prove it end-to-end** with live credentials: opt someone out on one side and
   verify the hub converges the other side, then confirm the sync-lag report shows
   the propagation confirming.

> **Details:** the per-platform recipes, the console registration flow, and the
> "definition of done per service" are in **[Integration](INTEGRATION.md)**. For a
> service a third party operates, hand them the matching page in
> **[`vendor-onepagers/`](vendor-onepagers/)**.

**Done when:** for every first-wave service, a real opt-out is captured, propagated
where writable, and visible as *confirmed* in the hub — with no leg left "unproven."

---

## Stage 5 — Wire your own senders to the consent gate

Withhold-only platforms (and any send path you control) only honor consent if the
sender asks first.

1. In each sending application you operate, call the hub's **consent-check** endpoint
   before sending, and **do not send** to anyone marked *suppress*.
2. **Fail closed** — if the hub is unreachable, withhold rather than send.
3. Use the **same identity normalization** the hub uses (phone numbers in E.164,
   emails lowercased) so the check matches.
4. For vendor-operated senders, hand the vendor their one-pager so they wire the same
   report + check calls.

**Done when:** every sender you control checks the hub before sending and fails
closed, verified with a suppressed test recipient who is correctly skipped.

---

## Stage 6 — Operational hardening

Make the system survivable and observable before real traffic depends on it.

1. **Backups & recovery** — schedule regular encrypted PostgreSQL backups stored off
   the host, capture `APP_SECRET` alongside them, and **perform a test restore**.
   See `RUNBOOK-backup-and-dr.md`.
2. **Monitoring** — scrape the metrics endpoint and watch liveness/readiness; build
   dashboards for consent-check latency, unconfirmed writes, and sync-lag breaches.
3. **Alerting** — route sync-lag breach alerts (the regulatory-ceiling ones) to a
   channel a human actually watches.
4. **Scheduled jobs** — confirm reconciliation, polling, audit-retention prune, and
   alert scans are running on their timers.
5. **Rotation** — know how to rotate `APP_SECRET` and service credentials. See
   `RUNBOOK-key-and-credential-rotation.md`.

**Done when:** a test restore has succeeded, alerts reach a real inbox/channel, and
the scheduled jobs are confirmed running.

---

## Stage 7 — Security and compliance sign-off

These are gates, not paperwork, for a consent-enforcement system.

1. **Independent security assessment** — complete a penetration test against the live
   deployment and remediate its findings.
2. **Security questionnaire** — complete your institution's security assessment
   (e.g. HECVAT) if required.
3. **Legal review** — confirm with counsel: consent retention windows, cross-channel
   "revoke-all" handling, and how consent history interacts with data-subject
   access/deletion requests (FERPA/privacy).
4. **Audit completeness** — verify every consent decision, override, and admin action
   is captured immutably.

**Done when:** the security assessment findings are closed and legal/compliance has
signed off in writing.

---

## Stage 8 — Testing and acceptance

1. **Performance test** at your expected scale — consent-check latency under campaign
   fan-out, and reconciliation across your full identity × service set.
2. **Failure drills** — exercise hub outage (senders fail closed), database failover,
   a webhook storm, and bad credentials.
3. **User acceptance testing** — have staff walk the console workflows: the category
   matrix, approvals, alerts, reports, and service configuration.

**Done when:** performance meets your target, the failure drills behave as designed,
and staff sign off on the console workflows.

---

## Stage 9 — Go live

1. Confirm every stage above is complete for the first-wave services.
2. Enable outbound writes for the launched services and turn on live traffic.
3. Watch the dashboards and alerts closely through the first days.

**Done when:** the first-wave services are live, honoring opt-outs end-to-end, and
being monitored.

---

## Stage 10 — Expand and mature (after launch)

Add the following as need and scale warrant — none are required for the first launch:

- **Add the remaining services** wave by wave, each through Stages 4–5.
- **High availability** — run more than one instance behind the load balancer, with a
  shared rate-limit store, once single-instance limits are reached.
- **Reliable background processing** — a job runner with retries/backoff for writes,
  polling, and reconciliation.
- **Deployment automation** — a repeatable release pipeline.
- **Continuous scanning** — dependency and container vulnerability scanning in CI.
- **Accessibility** — a formal accessibility audit / VPAT (promote earlier if
  procurement requires it).

---

## The short version

**Inventory → host → configure → prove each service → wire your senders → harden ops
→ security & legal sign-off → test → go live → expand.**

The software is the easy part; the work is proving each integration against a real
account and standing up a host you can operate and defend.
