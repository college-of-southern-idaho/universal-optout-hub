<p align="center">
  <img src=".github/assets/logo.png" alt="Universal Opt-Out Synchronization Hub" width="440">
</p>

<p align="center">
  An open-source reconciliation hub that synchronizes consent state — opt-outs and opt-ins for phone numbers and email addresses — across every messaging platform an organization uses.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="License: Apache 2.0"></a>
  <a href="https://github.com/college-of-southern-idaho/universal-optout-hub/actions/workflows/ci.yml"><img src="https://github.com/college-of-southern-idaho/universal-optout-hub/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A520-5FA04E?logo=node.js&logoColor=white" alt="Node">
  <img src="https://img.shields.io/badge/PostgreSQL-required-4169E1?logo=postgresql&logoColor=white" alt="PostgreSQL">
</p>

> **Project status:** A functional implementation, actively developed. The consent engine, reconciliation loop, opt-in approval workflow, manual management UI, authentication/RBAC, and an admin **service-configuration** surface are implemented (Node.js + TypeScript + Express + PostgreSQL). A catalog of 35 SMS/email platform types can be registered and configured from the UI; eight — **SendGrid**, **Twilio**, **Constant Contact**, **Telesign**, **Amazon SNS**, **Amazon SES**, **Azure Communication Services**, and **Modern Campus Message (Signal Vine)** — talk to the real platform APIs today, and the rest run on a simulator until their clients are written. See [DESIGN.md](DESIGN.md) for the architecture and [QUICKSTART.md](QUICKSTART.md) to run it.

## Documentation — start here

New to the project? Follow this path in order — each step hands off to the next, so you don't have to hunt across files:

| # | Read this | To… |
|---|---|---|
| 1 | **[OVERVIEW.md](OVERVIEW.md)** · [DESIGN.md](DESIGN.md) | understand what it does and how it's built *(read once)* |
| — | [UNDERSTANDING-CONSENT.md](UNDERSTANDING-CONSENT.md) | plain-language primer on opt-out/opt-in across channel & category *(for non-technical readers)* |
| 2 | **[QUICKSTART.md](QUICKSTART.md)** | run it locally and click through the console |
| 3 | **[SETUP-GUIDE.md](SETUP-GUIDE.md)** | **the linear path** — roll it out for your org (threads the steps below in order) |
| ↳ | [DEPLOYMENT.md](DEPLOYMENT.md) | stand up the production host (TLS, supervisor, edge hardening) |
| ↳ | [CONFIGURATION.md](CONFIGURATION.md) | every environment variable and policy knob, in one place |
| ↳ | [INTEGRATION.md](INTEGRATION.md) + [`vendor-onepagers/`](vendor-onepagers/) | connect and prove each messaging service |
| ↳ | [RUNBOOK-backup-and-dr.md](RUNBOOK-backup-and-dr.md) · [RUNBOOK-key-and-credential-rotation.md](RUNBOOK-key-and-credential-rotation.md) | operate it (backups/DR, rotation) |
| 4 | **[PRODUCTION-READINESS.md](PRODUCTION-READINESS.md)** | track *status* toward go-live (the checklist, not the instructions) |
| — | [SECURITY-REVIEW.md](SECURITY-REVIEW.md) · [SECURITY.md](SECURITY.md) · [ADRs](DESIGN.md) | reference: security posture, compliance, design decisions |

## The problem

Organizations rarely send messages through a single platform. A typical environment includes one or more SMS providers, an email marketing service, CRM-integrated messaging, and email-to-SMS gateways — each with its own independent suppression list. A consumer who texts STOP on one platform remains reachable through every other one.

That isn't just a bad experience; it's a legal exposure. Under the Telephone Consumer Protection Act (TCPA, 47 U.S.C. § 227), each message sent after a valid revocation of consent carries statutory damages of $500–$1,500, with a private right of action and no aggregate cap. FCC rules require opt-outs to be honored within 10 business days, and the FCC's pending "revoke-all" rule (currently scheduled to take effect January 31, 2027) will require a revocation received on one channel to be treated as applying broadly. Email carries its own obligations under CAN-SPAM.

This project makes cross-platform consent synchronization a solved infrastructure problem rather than a manual process.

## What it does

- **Propagates opt-outs automatically and immediately.** A revocation received on any connected platform is pushed to other platforms per a configurable **message-category cascade matrix** — so a marketing opt-out need not silence transactional or emergency messaging, and emergency/safety services are never suppressed — with sync lag tracked as a first-class metric.
- **Handles opt-ins conservatively.** An opt-in is always honored at the platform where it was received. Treating it as broader than that — propagating it to other systems — requires a human reviewer to confirm, against the stored consent evidence, that the consent actually covers those systems and channels.
- **Provides a manual management interface.** Employees can view consolidated consent state and full history for any identity, record manual opt-outs/opt-ins, work the opt-in approval queue, and respond to reconciliation alerts — with role-based access control and a complete audit trail.
- **Lets admins configure sending services.** A two-phase admin screen registers a service (pick a platform type, name it, store credentials server-side, test the connection), then discovers and reviews its sender pools / suppression groups. Services can be archived (hidden from operational views but retained for historical attribution) or deleted (only when they hold no consent history). Admin-only screens — Services, Users, and Appearance — sit under one role-gated **Admin** menu, and Appearance lets a deployment brand the console (org name, logo, colors).

## How it works (in brief)

The hub is a **reconciliation hub**, not a system of record: each messaging platform remains authoritative for its own state. For every (identity, system) pair the hub tracks the *observed* state reported by the platform and the *expected* state computed from its append-only event log and precedence rules, continuously detecting divergence and issuing corrective writes where the platform allows them.

Key design properties:

- **Provenance-aware consent model.** Every event is *explicit* (the consumer acted on that platform) or *derived* (the hub propagated it). A derived event never overrides an explicit one, and at equal provenance, opt-out always wins.
- **Deliberate asymmetry.** Opt-out propagation is automatic with no human in the loop; opt-in propagation is queued, human-gated, and evidence-backed — mirroring the legal asymmetry between over- and under-suppression.
- **Channel-scoped review.** Opt-in reviews are keyed by (identity, channel): same-channel events coalesce into one review, while SMS-origin and email-origin events are reviewed independently. Email-to-SMS gateways are classified as SMS for consent purposes, regardless of transport.
- **Event-sourced and auditable.** State is a recomputable projection over an immutable event log; consent evidence and approval attestations are stored immutably. These records are the concrete form of the TCPA § 227(c)(5) "reasonable practices and procedures" affirmative defense.
- **Pluggable adapters with a dispatching registry.** Each platform type declares its capabilities (channel classification, event delivery, read/write support, vendor suppression behavior, topology granularity); the registry builds the right client per registered service, dispatching on type and falling back to a simulator when a type has no live client yet or its credentials aren't set. Eight live clients exist today — **SendGrid**, **Twilio**, **Constant Contact**, **Telesign**, **Amazon SNS**, **Amazon SES**, **Azure Communication Services**, and **Modern Campus Message (Signal Vine)** — with the remaining types simulated until their clients are written.
- **Pre-send consent-check API.** A sending service can ask the hub, before sending, whether an identity is suppressed for a given system/channel (`POST /api/v1/consent/check`, machine-authed with per-system keys, fail-closed), and can report an opt-out it received itself (`POST /api/v1/consent/report`) without repointing its existing inbound webhook. This is how opt-out is enforced for platforms that keep no writable suppression list. See [ADR 0004](ADR-0004-consent-check-api.md).

The full architecture — state machine, precedence rules, schemas, approval workflow, adapter contract, and configuration surface — is in [DESIGN.md](DESIGN.md).

## Supported platforms

The hub is for any organization that must honor universal opt-out obligations across more than one messaging platform — not only the higher-education context it started in. The service catalog ([`optout-hub/src/adapters/catalog.ts`](optout-hub/src/adapters/catalog.ts)) covers **35 SMS and email platform types**. Each declares how that platform actually handles opt-out: most expose a **writable suppression surface** (the hub reads and writes opt-out state), while some are **withhold-only** — the platform keeps no caller-writable list, so opt-out is enforced by withholding sends (and, where the send path is our own code, by the pre-send [consent-check API](ADR-0004-consent-check-api.md)).

| Category | Platform | Channel | Opt-out handling |
|---|---|---|---|
| **Initial targets** | Twilio (custom texting) | SMS | Withhold-only |
| | Telesign (Anthology Reach) | SMS | Withhold-only |
| | Constant Contact | Email | Writable |
| | Email-to-SMS gateway | SMS | Withhold-only |
| **CPaaS / programmable SMS** | Vonage (Nexmo) | SMS | Writable |
| | Sinch | SMS | Writable |
| | Infobip | SMS | Writable |
| | Bird (MessageBird) | SMS | Writable |
| | Plivo | SMS | Writable |
| | Telnyx | SMS | Writable |
| | Bandwidth | SMS | Writable |
| | Amazon SNS / AWS End User Messaging | SMS | Writable |
| | Azure Communication Services | SMS | Writable |
| **Campaign / business SMS** | Attentive | SMS | Writable |
| | Klaviyo | SMS | Writable |
| | EZ Texting | SMS | Writable |
| | SimpleTexting | SMS | Writable |
| | SlickText | SMS | Writable |
| **Higher-ed texting** | Mongoose Cadence | SMS | Withhold-only |
| | Modern Campus Message (Signal Vine) | SMS | Withhold-only |
| **Email marketing / ESP** | Mailchimp | Email | Writable |
| | HubSpot | Email | Writable |
| | ActiveCampaign | Email | Writable |
| | Brevo (Sendinblue) | Email | Writable |
| | MailerLite | Email | Writable |
| | Mailjet | Email | Writable |
| | Salesforce Marketing Cloud | Email | Writable |
| | Adobe Marketo Engage | Email | Writable |
| | Dynamics 365 Customer Insights – Journeys | Email | Writable |
| **Transactional email** | Twilio SendGrid | Email | Writable |
| | Amazon SES | Email | Writable |
| | Mailgun | Email | Writable |
| | Postmark | Email | Writable |
| | Mailchimp Transactional (Mandrill) | Email | Writable |

Plus a **Mock** type that backs every service in the PoC until a real client ships.

### Live API clients

Eight types talk to the real platform API today; the rest register and configure fully but run on the simulator until their clients are written (the registry switches a service to its live client automatically once one exists and its credentials are set):

| Platform | Channel | Live behavior |
|---|---|---|
| Twilio Programmable Messaging | SMS | Authenticates (Account SID + Auth Token **or** an API Key SK/secret); discovers Messaging Services (sender pools) and the phone numbers / short codes within each. Inbound STOP/START via a signed webhook, via **Event Streams** (`POST /api/webhooks/twilio-events/:systemId` — an additive path when the Messaging Service's own webhook is owned by another app), or via a sender's `POST /api/v1/consent/report`. Opt-out **writes** via the Consent Management API (bulk); Twilio exposes no opt-out read, so state can't be read back. Can auto-provision its inbound webhook. |
| Twilio SendGrid | Email | Authenticates; discovers suppression groups; reads/writes global suppression (opt-out / opt-in); signed Event Webhook (unsubscribe / spamreport / group (un)subscribe) → ingest. |
| Constant Contact | Email | OAuth 2.0 with refresh-on-401 (rotating-token persistence); poll-based ingestion of unsubscribes; writes opt-out/opt-in to the contact list. |
| Telesign | SMS | Authenticates; withhold-only (no caller-writable list); inbound STOP/START via the signed MO callback (HMAC-SHA256) → ingest; enforced at send time via the consent-check API. |
| Amazon SNS | SMS | SigV4-signed; reads opt-out state (`CheckIfPhoneNumberIsOptedOut`) and writes opt-in (`OptInPhoneNumber`); SNS keeps no caller-writable opt-out. |
| Amazon SES | Email | SigV4-signed; reads/adds/removes entries on the account-level suppression list (opt-out / opt-in). |
| Azure Communication Services | SMS | HMAC-signed; checks / adds / removes numbers on the opt-out list (opt-out / opt-in). |

## Roadmap

1. ~~Finalize the design~~ — documented in [DESIGN.md](DESIGN.md) and the ADRs.
2. ~~Core: identity normalization, event log, state projection, precedence engine.~~ ✅
3. ~~Reconciliation loop and adapter contract.~~ ✅
4. ~~Opt-in approval queue and manual management UI.~~ ✅
5. ~~Service-configuration surface: catalog, credential store, discovery/review, archive/delete, and the dispatching adapter registry.~~ ✅
Cross-platform enforcement needs three directions working together — the **enforcement triangle**. Items 6–8 are the three legs:

6. **Outbound writes across live adapters** (*hub pushes*) — build live clients for the remaining catalog types and, where a platform keeps a caller-writable list, submit opt-out/opt-in via its API. Eight clients exist (SendGrid, Twilio, Constant Contact, Telesign, Amazon SNS, Amazon SES, Azure Communication Services, Modern Campus Message (Signal Vine)); the rest follow the same shape.
7. **Inbound events → ingest** (*hub learns*) — ✅ signature-verified webhook endpoints for **Twilio** STOP/START, the **SendGrid** Event Webhook, and the **Telesign** MO STOP/START callback (`POST /api/webhooks/{twilio,sendgrid,telesign}/<system>`); **Twilio Event Streams** (`POST /api/webhooks/twilio-events/<system>`, an additive path for opt-outs when a Messaging Service's inbound webhook is owned by another app); a sender-reported path (`POST /api/v1/consent/report`); and **poll-based ingestion** for no-webhook platforms (Constant Contact) all map platform events into `ingest`, so a consumer opt-out on a live platform reconciles back and propagates. Remaining: wire the platform-side webhook/callback configs and exercise end-to-end with real credentials.
8. **Real-time consent-check API** (*sender asks*) — a machine-authed, fail-closed endpoint a sending service calls before sending, to ask whether an identity is suppressed for that system/channel. This is the **only** enforcement path for withhold-only platforms (Telesign, Twilio, higher-ed texting, email-to-SMS gateways), which have no writable list to push into. Design: [ADR 0004](ADR-0004-consent-check-api.md). **Implemented for Class B** (`POST /api/v1/consent/check`, per-system service-key auth, and an admin panel to issue/revoke keys), with **reference sender integrations** for both Class B senders — the custom Twilio texting app ([`optout-hub/examples/twilio-sender/`](optout-hub/examples/twilio-sender/)) and the email-to-SMS gateway ([`optout-hub/examples/email-sms-gateway-sender/`](optout-hub/examples/email-sms-gateway-sender/)) — sharing one fail-closed [gate](optout-hub/examples/consent-gate/) that gates every send on the hub. **Per-key rate limiting** (a per-key token bucket, default 60 req/s, configurable per key, `429` + `Retry-After` on breach), the **split-retention prune** for the `consent_checks` audit table (suppress ≈ 4 yr, allow/error ≈ 90 days; on-demand via `POST /api/consent-checks/prune` and an admin card, scheduled in production) — paralleled by a retention prune for the operational `audit_log` (default 14-day window, with compliance-relevant actions kept indefinitely; `POST /api/audit-log/prune` and an admin card, also scheduled) — and a **fail-to-cache availability path** (a hub-synced suppression cache fed by `GET /api/v1/consent/suppressions`, so a hub outage degrades to the last-known list rather than withholding everything) are now built. Remaining: wiring the reference gate into the real production senders, and the Class C vendor integrations.
9. **Operational hardening** — scheduled reconciliation + sync-lag alerting, OAuth token refresh, retry/backoff for async adapters.
10. **UI / branding expansion** — ✅ the Appearance surface now covers a full color palette (header, text, cards, accent/links, status colors), a favicon and browser-tab title, and login-screen branding, all applied live. Remaining ideas: typography/font choice and per-page theming.

Near-term focus is **7 + 8 together**: they are the two halves that make cross-platform opt-out actually enforceable for platforms the hub cannot write to.

## Contributing

The most useful contributions right now are design review and adapter expertise: if you operate one of the target platforms (or one we haven't listed) and know the quirks of its opt-out events, webhooks, or suppression behavior, please open an issue. Writing a live client for one of the still-simulated platform types — they all follow the shape of the eight existing live clients — is the highest-leverage code contribution; start with the **new-adapter compatibility checklist** in [DESIGN.md § 9.2](DESIGN.md), which walks the ways a platform can diverge from the model.

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to contribute. Contributions are accepted under the Apache License 2.0, and the project requires a signed Contributor License Agreement — the [Individual CLA](CLA-individual.md) or, for contributions made on behalf of an employer, the [Corporate CLA](CLA-corporate.md).

## Disclaimer

This software is intended to help organizations operationalize consent management. It is **not legal advice**, and using it does not by itself ensure compliance with the TCPA, FCC regulations, CAN-SPAM, or state law. Regulatory requirements change — verify current obligations with qualified counsel.

## License

Licensed under the **Apache License, Version 2.0** — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE). Copyright 2026 College of Southern Idaho.
