# Integrating a Messaging Service with the Consent Hub

**Audience:** IT staff wiring the Consent Hub into an existing messaging stack.
This document lays out **every way the hub can talk to a messaging service**, and
**every way a messaging service or carrier can talk back to the hub**, so opt-outs
and opt-ins stay in sync in both directions. It then gives the **per-vendor
options** for each of the 35 supported service types.

Paths like `POST /api/…` are on the hub; code references are relative to
`optout-hub/`. For the current *live-vs-planned* status of each vendor, this doc
is cross-checked against [PRODUCTION-READINESS.md](PRODUCTION-READINESS.md) §0.

> **Just want to wire up your stack?** Jump to **[§11 — Worked examples](#11-worked-examples-recipes)**
> for a complete, step-by-step recipe (the first one answers *"we use Twilio and
> Telesign — how do we make them work together?"*).

---

## 1. The mental model: the enforcement triangle

For any one service, consent "works" when the legs that apply to it are wired
(DESIGN.md §8–§11):

| Leg | Direction | What it does |
|---|---|---|
| **Outbound write** | hub → platform | Hub pushes an opt-out/opt-in into the platform's own suppression/subscription list. |
| **Inbound ingest** | platform → hub | Hub learns about opt-outs the platform received (a consumer texting STOP, an unsubscribe click). |
| **Consent-check gate** | sender → hub | The sending code asks the hub "may I contact this person?" before sending, and fails closed. |

Which legs apply depends on the service's **capability pattern**:

- **Pattern A — writable.** The platform exposes a caller-writable suppression or
  subscription list. The hub can *both* write opt-outs to it *and* ingest the
  opt-outs it receives. (Most ESPs and CPaaS platforms.)
- **Pattern B — withhold-only.** The platform has **no** caller-writable list
  (e.g. Telesign, Mongoose). The hub can't push state to it, so it enforces an
  opt-out by **withholding sends** — which only works if the sender consults the
  **consent-check gate** first. The hub still ingests the platform's own opt-outs.

You set the pattern per system with two capability flags — `can_write_optout` and
`can_write_optin` — which default correctly per vendor (see the matrix in §7) and
can be overridden at registration.

---

## 2. Outbound — how the hub talks TO a messaging service

When a system is **pattern A**, the hub's adapter for that platform writes consent
changes into the platform's API:

- **Opt-out captured anywhere** (a STOP on one carrier, an operator action, an
  approval) **propagates** to every other in-scope system per the category cascade
  (see §6 of DESIGN.md / ADR-0005), and for each writable target the adapter calls
  the platform's "suppress / unsubscribe" API.
- **Opt-in** is written the same way where `can_write_optin` is on. It defaults
  **off** for some platforms (e.g. Twilio) because re-subscribing someone is the
  riskier direction and is usually approval-gated.
- **Reconciliation** reads state back where the platform exposes a read
  (`observe()`), so drift from a missed webhook self-heals.

When a system is **pattern B**, the hub makes **no outbound write** — enforcement
happens entirely through the gate (§4) plus inbound ingest (§3).

Outbound is configured simply by **registering the system** with the right
`adapter_type`, its credentials, and the capability flags. No endpoint wiring on
your side — the hub calls *out* to the platform.

> **Test mode — receive without pushing.** While you're wiring up and validating
> services, you usually want to confirm the hub can *receive* opt-ins/opt-outs
> without it *pushing* anything into a live vendor's suppression list. Set the
> master safety switch **`ENABLE_OUTBOUND_WRITES=false`** (env, or Settings →
> Safety). With it off, the hub still ingests and records events and cascades them
> internally (so you can verify the logic and reports), but **never calls any
> platform's write API** — it just logs "would have written." A loud
> `outbound_writes_disabled` line is emitted at every startup so you can't forget
> it's on. Flip it to `true` (and run a reconcile) when you go to production; the
> accumulated opt-outs flush to the platforms then. This is a single global
> guarantee — safer than trying to set `can_write_*` false on every system.

---

## 3. Inbound — how a messaging service / carrier talks BACK to the hub

This is the two-way half, and there are **five** mechanisms. A given service can
use one or several; pick by what the platform supports and what you control.

### 3a. Per-platform signed webhook  →  `POST /api/webhooks/<type>/<system-id>`
The platform calls the hub in real time on each opt-out/opt-in. The hub verifies
the platform's own signature and de-duplicates replays. **Implemented today for
Twilio, SendGrid, and Telesign**; other platforms' handlers are on the roadmap.
- **Auth:** the platform's signature scheme, checked with that system's stored
  credentials (e.g. Twilio Auth Token, SendGrid Ed25519 key, Telesign HMAC).
- **Setup:** point the platform's webhook at the URL above. Set
  `WEBHOOK_PUBLIC_BASE` to the hub's public HTTPS base first — it must be
  internet-reachable and match the signed URL. Some adapters can **auto-provision**
  it: `POST /api/systems/<id>/provision-webhook` (admin).

### 3b. Twilio Event Streams sink  →  `POST /api/webhooks/twilio-events/<system-id>?token=…`
The answer to *"a third-party app owns my Messaging Service's inbound webhook and
I can't repoint it."* Subscribe to `com.twilio.messaging.inbound-message.received`
and point the Sink at this URL; Twilio streams a **copy** of every inbound message
(with `optOutType`) in **parallel** to the existing webhook. **One account-level
subscription covers every Messaging Service**, and each event is routed to the
right system by matching its `messagingServiceSid`.
- **Auth:** a shared token (`TWILIO_EVENTS_TOKEN`) in the Sink URL `?token=` or an
  `x-events-token` header (Event Streams isn't request-signed like webhooks).
- **Use when:** you can't take over the per-service webhook, or you want one feed
  for many Messaging Services.

### 3c. Sender-reported opt-out  →  `POST /api/v1/consent/report`
Lets a sender you *do* control forward an opt-out it saw (e.g. its own inbound
STOP handler) **without repointing any platform webhook**. Same ingest path as a
webhook, so propagation/precedence/audit are identical.
- **Auth:** a per-system **service API key** (`X-API-Key` / `Authorization: Bearer`).
- **Body:** `{ "system": "<id>", "value": "+1208…", "direction": "opt_out", "source": "inbound STOP" }`
- **Use when:** you own the receiving app and can add one API call, but can't or
  don't want to change where the carrier sends its webhook.

### 3d. Poll (hub pulls on a schedule)
For platforms with no webhook but a queryable opt-out list, the hub pulls on a
timer (`src/services/poller.ts`, `POLL_INTERVAL_MINUTES`, per-system cursor), or
on demand via `POST /api/poll` / `POST /api/poll/<system-id>` (operator). Set the
system's delivery mode to **poll**. (Constant Contact, Amazon SES/SNS, ACS, EZ
Texting, Marketo, Mongoose default to poll.)

### 3e. Export / import (batch)
For platforms that only produce a periodic opt-out **export** (email-to-SMS
gateway, Modern Campus). The system's delivery mode is **export**; a batch import
folds the list into consent state. *(Import pipeline is designed, not yet built —
see PRODUCTION-READINESS.md.)*

> **Also:** operators can record events by hand in the console, or via
> `POST /api/events` (session-authenticated, role `operator`) — useful for
> back-office corrections and one-off imports. Attribution comes from the session,
> never the request body.

---

## 4. The consent-check gate — how a sender ASKS before sending

This is how a **pattern-B** service (and any send path you control) honors
opt-outs the hub can't write into the platform. Your sending code calls the hub
before each send and **fails closed** if the hub is unreachable.

- **Live check:** `POST /api/v1/consent/check`
  - Auth: service API key. Body: `{ "system": "<id>", "channel": "sms|email", "identities": ["+1208…", "a@b.edu"] }`
  - Returns per identity: `decision` (`allow` / `suppress` / `error`), `state`, `reason`, `as_of`.
  - **Mode is hub-wide policy** (`consentCheckMode`): *blocklist* (unknown → send) or *allowlist* (only explicit opt-in → send).
- **Suppression feed (for a local cache):** `GET /api/v1/consent/suppressions?system=<id>&since=<ISO>`
  - Without `since`: the full current suppression baseline. With `since`: the delta.
  - Keep a synced local list so a hub outage degrades to last-known state instead of blocking every send. `examples/` has reference gates.
- A key is **scoped to one system** and rate-limited (`consentCheckRateLimitPerSec`).

> **Normalization parity matters.** The sender must normalize phone/email the same
> way the hub does (libphonenumber E.164, lowercase email) so cache keys line up
> (ADR-0004). The reference gate ships a light normalizer; production senders
> should use the hub's exact rules.

---

## 5. Auth, at a glance

| Inbound/outbound path | Auth mechanism |
|---|---|
| Platform webhook (`/api/webhooks/<type>/<id>`) | The platform's own signature, verified with that system's stored credentials |
| Twilio Event Streams (`/api/webhooks/twilio-events/<id>`) | Shared `TWILIO_EVENTS_TOKEN` (URL `?token=` or `x-events-token`) |
| Consent-check / report / suppressions (`/api/v1/consent/*`) | Per-system **service API key** (`X-API-Key` or `Bearer`), rate-limited |
| Operator event (`/api/events`), admin/config routes | Session login + role (OIDC or local), CSRF-protected |
| Outbound writes (hub → platform) | The platform credentials you store per system (encrypted at rest) |

Create a service API key: `POST /api/systems/<id>/api-keys` (admin), shown once.

---

## 6. Choosing the right combination

| Your situation | Recommended wiring |
|---|---|
| Platform has a writable list **and** a webhook | **Pattern A + webhook** (3a). Real-time both ways. Best case. |
| Writable list, **no** webhook (polling API) | **Pattern A + poll** (3d). |
| Twilio, but a third-party app owns the inbound webhook | **Event Streams** (3b), or **sender-report** (3c) if you control the app. |
| No writable list (withhold-only) | **Consent-check gate** (4) + inbound ingest via whatever the platform offers (webhook/poll/export). |
| You control the sending app and can add one HTTP call | **Sender-report** (3c) inbound + **gate** (4) outbound-equivalent. |

---

## 6a. Third-party / vendor-owned services (no vendor secrets needed)

Many senders that message your students run on a **vendor's own account** — e.g.
DualEnroll sending via *its* Twilio, not yours. You can still bring these under the
hub, and **you do not need the vendor's credentials to do it.** The blocker is
vendor *cooperation* (a one-time config on their side), not their *secrets*.

**Identifiers vs. secrets — the key distinction.** A Twilio account exposes both:
- **Identifiers** — `Account SID` (`AC…`) and `Messaging Service SID` (`MG…`). *Not
  secrets*; a vendor can share these like an account number.
- **Secrets** — the `Auth Token` / API Key secret. A vendor won't (and shouldn't)
  share these.

You only ever need the **secret** for three things — all of which are the *wrong*
approach for a vendor-owned account anyway:
- the hub's **"Provision inbound webhook"** button (it calls Twilio's API on your
  behalf) — **don't use it for a vendor account;**
- **verifying** classic webhook signatures;
- **outbound writes** (pushing your opt-outs *into* their platform).

**The pattern (Twilio example):**
1. **Register** the system with the **Account SID + Messaging Service SID** only
   (get these from the vendor; leave the **Auth Token blank** — it's optional).
   That's enough for the hub to route their events by Messaging Service SID.
2. **Do not provision from the hub.** Give the vendor your Event Streams sink URL +
   shared token — `https://<hub>/api/webhooks/twilio-events/<system-id>?token=<TWILIO_EVENTS_TOKEN>`
   — and *they* create the Event Streams subscription on their account. **No secret
   changes hands;** the hub authenticates the stream with the token you provided.
3. Optionally/additionally, the vendor calls **`POST /api/v1/consent/report`**
   (to forward opt-outs) and **`POST /api/v1/consent/check`** (before sending) with a
   **service API key you issue** — again, no vendor secret.

**What you can and can't achieve for a vendor-owned sender:**

| Leg | Vendor-owned account | Needs from the vendor |
|---|---|---|
| **Inbound ingest** (hub learns of opt-outs) | ✅ Yes | They configure Event Streams, or call `/consent/report` with your key. *Config, not secrets.* |
| **Consent-check gate** (they ask before sending) | ✅ Yes — the only way to honor a STOP made *elsewhere* | They add one API call with your key. *Requires dev cooperation.* |
| **Outbound write** (hub pushes opt-outs into their platform) | ❌ No | Their secret — off the table. Mitigated by the platform's native STOP + the gate. |

**The one truly blocked case** is a vendor who configures *nothing* — then you can
neither receive their opt-outs nor enforce. The design flags this up front (DESIGN.md
§9.2: *"a third-party app you can't modify has no enforcement path — screen for it up
front"*).

**Your leverage — make it a contract term.** The TCPA/CAN-SPAM obligation attaches
to the **institution**, not the vendor, so you can require opt-out integration in the
vendor agreement / DPA: *"any vendor sending SMS/email on our behalf must forward
opt-outs to our consent hub (Event Streams or the report API) and check the consent
API before sending."* Cataloguing these senders (the messaging-service inventory) is
step one to putting that requirement in front of each vendor. A **vendor-facing
one-pager** you can hand over is at
[VENDOR-INTEGRATION-ONEPAGER.md](VENDOR-INTEGRATION-ONEPAGER.md).

---

## 7. Per-vendor matrix

**Legend** — Pattern: **A** writable · **B** withhold-only. "Write out": can the
hub push **opt-out** / **opt-in** to the platform. "Inbound (default)": the
delivery mode the vendor defaults to; you can change it per system. **Live**: ✅ a
real client exists today; ⬜ cataloged but currently on the mock adapter (register
+ configure works, but no real opt-out path yet — see PRODUCTION-READINESS.md).

### Initial CSI targets
| Service | Chan | Pattern | Write out (out/in) | Inbound (default) | How it talks back / where to point it | Live |
|---|---|---|---|---|---|---|
| **Twilio (custom texting)** | SMS | A/B | ✅ / ⬜(opt-in off by default) | webhook | `/api/webhooks/twilio/<id>` (Auth-Token signature); **or** Event Streams `/api/webhooks/twilio-events/<id>?token=` (account-level, routed by Messaging Service SID); **or** sender-report | ✅ |
| **Telesign (Anthology Reach)** | SMS | B | ✗ / ✗ | webhook | Telesign **MO callback** → `/api/webhooks/telesign/<id>` (HMAC-SHA256 with your API key) | ✅ |
| **Constant Contact** | Email | A | ✅ / ✅ | poll | Hub **polls** (OAuth); no webhook. Provide `client_secret` + `refresh_token` for unattended refresh | ✅ |
| **Email-to-SMS gateway** | SMS | B | ✗ / ✗ | export | No consent API — opt-out enforced at send + batch **export/import** | ✅ (send) |

### SMS · CPaaS / programmable
| Service | Chan | Pattern | Write out (out/in) | Inbound (default) | How it talks back | Live |
|---|---|---|---|---|---|---|
| Vonage (Nexmo) | SMS | A | ✅ / ✅ | webhook | Platform webhook (roadmap handler) | ⬜ |
| Sinch | SMS | A | ✅ / ✅ | webhook | Platform webhook | ⬜ |
| Infobip | SMS | A | ✅ / ✅ | webhook | Platform webhook | ⬜ |
| Bird (MessageBird) | SMS | A | ✅ / ✅ | webhook | Platform webhook | ⬜ |
| Plivo | SMS | A | ✅ / ✅ | webhook | Platform webhook | ⬜ |
| Telnyx | SMS | A | ✅ / ✅ | webhook | Platform webhook | ⬜ |
| Bandwidth | SMS | A | ✅ / ✅ | webhook | Platform webhook | ⬜ |
| **Amazon SNS / EUM** | SMS | A | ✗ / ✅ | poll | Hub **reads** opt-out (`CheckIfPhoneNumberIsOptedOut`) + re-opt-in (`OptInPhoneNumber`); recipients opt out by texting STOP | ✅ |
| **Azure Communication** | SMS | A | ✅ / ✅ | poll | ACS **Opt-Out Management API** scoped to `from_number` (check/add/remove) | ✅ |

### SMS · campaign / business
| Service | Chan | Pattern | Write out (out/in) | Inbound (default) | How it talks back | Live |
|---|---|---|---|---|---|---|
| Attentive | SMS | A | ✅ / ✅ | webhook | Platform webhook | ⬜ |
| Klaviyo | Email/SMS | A | ✅ / ✅ | webhook | Platform webhook (register one system per channel) | ⬜ |
| EZ Texting | SMS | A | ✅ / ✅ | poll | Hub polls | ⬜ |
| SimpleTexting | SMS | A | ✅ / ✅ | webhook | Platform webhook | ⬜ |
| SlickText | SMS | A | ✅ / ✅ | webhook | Platform webhook | ⬜ |

### SMS · withhold-only / vertical
| Service | Chan | Pattern | Write out (out/in) | Inbound (default) | How it talks back | Live |
|---|---|---|---|---|---|---|
| Mongoose Cadence | SMS | B | ✗ / ✗ | poll | STOP handled in-platform; hub **polls** and suppresses via the gate | ⬜ |
| Modern Campus Message (Signal Vine) | SMS | B | ✗ / ✗ | export | In-platform; **export/import**; gate suppresses | ⬜ |

### Email · marketing / ESP
| Service | Chan | Pattern | Write out (out/in) | Inbound (default) | How it talks back | Live |
|---|---|---|---|---|---|---|
| Mailchimp | Email | A | ✅ / ✅ | webhook | Platform webhook | ⬜ |
| HubSpot | Email | A | ✅ / ✅ | webhook | Platform webhook (private-app token, or OAuth refresh) | ⬜ |
| ActiveCampaign | Email | A | ✅ / ✅ | webhook | Platform webhook | ⬜ |
| Brevo (Sendinblue) | Email/SMS | A | ✅ / ✅ | webhook | Platform webhook (one system per channel) | ⬜ |
| MailerLite | Email | A | ✅ / ✅ | webhook | Platform webhook | ⬜ |
| Mailjet | Email/SMS | A | ✅ / ✅ | webhook | Platform webhook | ⬜ |
| Salesforce Marketing Cloud | Email | A | ✅ / ✅ | webhook | Platform webhook (OAuth) | ⬜ |
| Adobe Marketo Engage | Email | A | ✅ / ✅ | poll | Hub polls (OAuth client-credentials) | ⬜ |
| Dynamics 365 Journeys | Email | A | ✅ / ✅ | webhook | Platform webhook (Azure AD app) | ⬜ |

### Email · transactional / SMTP API
| Service | Chan | Pattern | Write out (out/in) | Inbound (default) | How it talks back | Live |
|---|---|---|---|---|---|---|
| **Twilio SendGrid** | Email | A | ✅ / ✅ | webhook | **Signed Event Webhook** → `/api/webhooks/sendgrid/<id>` (Ed25519 verification key) | ✅ |
| **Amazon SES** | Email | A | ✅ / ✅ | poll | SESv2 **account suppression list** read/write (add on opt-out, remove on opt-in) | ✅ |
| Mailgun | Email | A | ✅ / ✅ | webhook | Platform webhook | ⬜ |
| Postmark | Email | A | ✅ / ✅ | webhook | Subscription-management webhook | ⬜ |
| Mailchimp Transactional (Mandrill) | Email | A | ✅ / ✗ | webhook | Platform webhook (opt-out only; account reject list) | ⬜ |

---

## 8. Per-vendor notes for the special cases

- **Twilio.** The most flexible — and the one with the most inbound options.
  Opt-out is now **writable** via the Consent Management API (bulk upsert), so the
  hub can push an opt-out captured elsewhere *into* Twilio; this needs a
  **Messaging Service SID**. Opt-in write is **off by default** (approval-gated
  re-subscribe is safer) and can be enabled per system. Inbound has three routes:
  the per-service **webhook** (signature uses the **Auth Token** — keep it set even
  if you authenticate REST calls with an API Key), **Event Streams** (best when a
  third-party owns the webhook, or to cover many Messaging Services with one feed),
  and **sender-report**. Different Messaging Services can each pick a different
  inbound route and keep their own category.
- **Telesign (Anthology Reach).** No caller-writable suppression list — **pattern
  B**. Opt-out = withhold. Wire the **MO (mobile-originated) callback** to
  `/api/webhooks/telesign/<id>`; the hub verifies HMAC-SHA256 over the body with
  your API key.
- **Constant Contact.** OAuth; access tokens last ~24h. Provide `client_secret` +
  `refresh_token` so the hub refreshes unattended (the refresh token rotates on
  each use). Consumer opt-outs are **polled**, not pushed.
- **SendGrid.** Turn on the **Signed Event Webhook** and paste its Base64 ECDSA
  (P-256) verification key as `event_webhook_key` — required to accept inbound
  unsubscribe/spamreport events at `/api/webhooks/sendgrid/<id>`.
- **Amazon SNS.** Asymmetric: the hub can **read** opt-out status and **re-opt-in**,
  but **cannot force an opt-out** (recipients opt out by texting STOP). Scope the
  IAM principal to SNS SMS actions only.
- **Amazon SES / Azure Communication.** Full read/write suppression surfaces
  (SESv2 account list; ACS Opt-Out Management scoped to `from_number`). Ingested by
  **poll**; reconciliation works.
- **Email-to-SMS gateway / Mongoose / Modern Campus.** No consent API — enforcement
  is **gate + inbound (export or poll)**. Channel for the gateway is **locked to
  SMS** (consent classification, not transport).

---

## 9. Registering a service (the console flow)

1. **Add the system:** `POST /api/systems` (admin) or the Service Config screen —
   pick the `adapter_type`, name, **channel**, and **category** (drives the opt-out
   cascade). Capability flags default per vendor (§7); override if needed.
2. **Store credentials:** `PUT /api/systems/<id>/credentials` — the fields listed
   for that vendor in the catalog; secrets are encrypted at rest.
3. **Test the connection:** `POST /api/systems/<id>/test`.
4. **Wire inbound** (pick per §3): provision/point the webhook, add the Event
   Streams sink, configure the sender-report call, or set poll/export mode.
5. **Wire the gate** (pattern B or any send path you control): mint a service API
   key (`POST /api/systems/<id>/api-keys`) and call `/api/v1/consent/check` before
   sending.
6. **Verify two-way sync:** trigger a STOP on the platform → confirm it appears in
   the hub (identity lookup / audit), and push a hub opt-out → confirm it reaches
   the platform (for pattern A). The sync-lag report flags anything that didn't
   converge.

---

## 10. Definition of "done" per service

- **Pattern A (writable):** live outbound write **+** inbound ingest
  (webhook/poll/export) **+** credential/OAuth handling **+** an integration test
  against the platform's sandbox.
- **Pattern B (withhold-only):** inbound ingest **+** the sender wired to the
  consent-check gate **+** an integration test.
- **Both patterns:** a **worked recipe added to [§11b](#11b-recipes-for-each-built-out-live-service)**
  (*Register → Inbound → Enforcement → Verify*), so an integrator using the platform
  has a concrete walkthrough. An adapter is not done until its recipe is documented.

See [PRODUCTION-READINESS.md](PRODUCTION-READINESS.md) §0 for the authoritative,
per-service build status, and [ADR-0004](ADR-0004-consent-check-api.md) for the
Class-B consent-check API contract.

---

## 11. Worked examples (recipes)

### 11a. "We use Twilio and Telesign — how do we make them work together?"

Both are **SMS**, but they sit at opposite ends of the capability spectrum, and
that difference decides what you have to wire:

- **Twilio** is **writable** — the hub can *push* an opt-out into it (Consent
  Management API) and Twilio then suppresses natively.
- **Telesign** is **withhold-only** — the hub *cannot* push anything to it, so the
  only way an opt-out is honored on Telesign is if your Telesign sender **asks the
  hub first**.

Goal: *a STOP received on either platform silences the person on **both**.*

**Prerequisites (hub env):** `WEBHOOK_PUBLIC_BASE` (public HTTPS base of the hub),
and — if you'll use Twilio Event Streams — `TWILIO_EVENTS_TOKEN`.

**Step 1 — Register both systems** (Service Config screen or `POST /api/systems`):

| | Twilio system | Telesign system |
|---|---|---|
| `adapter_type` | `twilio` | `telesign` |
| `channel` | `sms` | `sms` |
| `category` | e.g. `marketing` | e.g. `marketing` |
| `can_write_optout` | **true** | **false** (default) |
| `can_write_optin` | false (default) | false (default) |
| credentials | `account_sid`, `api_key_sid`+`api_key_secret` (or `auth_token`), **`messaging_service_sid`** | `customer_id`, `api_key` |

**Step 2 — Make an SMS opt-out cover both.** Put both systems in the **same
category** (e.g. `marketing`), or set the category **cascade matrix** so their
categories propagate to each other. Because both are `sms`, channel-scoping lets
the opt-out cascade between them; keep any `emergency` category **protected** so it
is never suppressed.

**Step 3 — Wire inbound (platform → hub) for each:**
- **Twilio** — pick the route that fits who owns the Messaging Service webhook:
  - *You own it:* point the Messaging Service's inbound webhook at
    `https://<hub>/api/webhooks/twilio/<twilio-system-id>` (keep `auth_token` set —
    it verifies the signature).
  - *A third-party app owns it (can't repoint):* create a Twilio **Event Streams**
    subscription on `com.twilio.messaging.inbound-message.received` with a Sink at
    `https://<hub>/api/webhooks/twilio-events/<twilio-system-id>?token=$TWILIO_EVENTS_TOKEN`.
    One subscription covers every Messaging Service; events route by
    `messagingServiceSid`.
- **Telesign** — point the Telesign Messaging **MO (mobile-originated) callback**
  at `https://<hub>/api/webhooks/telesign/<telesign-system-id>` (the hub verifies
  HMAC-SHA256 with your `api_key`).

**Step 4 — Wire enforcement (the crucial asymmetry):**
- **Twilio needs nothing extra outbound.** When an opt-out lands from *anywhere*
  (including a Telesign STOP), the hub pushes it into Twilio's Consent API and
  Twilio suppresses. (This is why `messaging_service_sid` is required.)
- **Telesign REQUIRES the gate.** Since the hub can't write to Telesign, your
  Telesign / Anthology Reach send path **must** call the consent-check gate before
  sending, or a Twilio-origin STOP will never stop your Telesign messages:
  1. Mint a key: `POST /api/systems/<telesign-system-id>/api-keys` (shown once).
  2. Before each send:
     ```
     POST /api/v1/consent/check
     X-API-Key: <key>
     { "system": "<telesign-system-id>", "channel": "sms", "identities": ["+12085550123"] }
     ```
     Drop any identity whose `decision` is `suppress`; **fail closed** if the hub
     is unreachable. Optionally sync `GET /api/v1/consent/suppressions` into a local
     cache so a hub outage degrades gracefully.

**Step 5 — Verify both directions:**
- Text **STOP** to a Twilio number → the hub records the opt-out on the Twilio
  system → it cascades to the Telesign system → a `consent/check` for that number
  on the Telesign system now returns `suppress`.
- Text **STOP** through Telesign → the MO callback records it on the Telesign
  system → it cascades to Twilio → the hub writes it into Twilio's Consent API, so
  even Twilio-native sends stop.
- Confirm with an identity lookup and the **sync-lag report** (flags anything that
  didn't converge in time).

**The one-sentence takeaway:** *Twilio is handled for you once registered with a
Messaging Service SID and an inbound route; the only mandatory work on your side is
making the **Telesign sender call `/api/v1/consent/check`** — that's what closes the
loop for the withhold-only platform.*

> **Troubleshooting a Twilio Event Streams sink (403 / 503).** The token in the
> sink URL (`?token=…`) is **`TWILIO_EVENTS_TOKEN`** — a shared secret *you*
> generate (e.g. `openssl rand -hex 32`) and set on the hub, **not** a Twilio Auth
> Token. What the status codes mean:
> - **`503 TWILIO_EVENTS_TOKEN not configured`** — the hub has no token set. Set it
>   (env or `_FILE`) and **restart** — it's read once at startup. Note env vars
>   already set in the process **override `.env`** (common on IIS/systemd: a
>   `web.config <environmentVariables>` or unit `Environment=` wins). Verify the
>   live value with `printenv TWILIO_EVENTS_TOKEN` (or, on Windows, `[Environment]::GetEnvironmentVariable("TWILIO_EVENTS_TOKEN","Machine")`).
> - **`403 invalid token`** — the hub *has* a token but the presented one doesn't
>   match (the comparison is exact — any stray character fails). Usual culprits:
>   the sink URL has a copy artifact (a trailing `>`, a space, a truncated token);
>   a base64 token (`+ / =`) got mangled in the query string (use a **hex** token,
>   or the `x-events-token` header); or the `.env` value differs from what's live.
> - **Isolate it with a direct request** — send the token as a header to rule out
>   URL-encoding:
>   ```
>   curl.exe -i -X POST "https://<hub>/api/webhooks/twilio-events/<system-id>" \
>     -H "x-events-token: <TOKEN>" -H "content-type: application/json" -d "{}"
>   ```
>   `200 {"ok":true,"ingested":0}` = the hub token is correct, so the fault is in
>   the **sink URL**; still `403` = the hub's loaded token is wrong (restart / env
>   precedence / typo).
> - **PowerShell gotcha:** `curl` is an alias for `Invoke-WebRequest`. Use
>   `curl.exe`, keep each `-H` on one line (a line break inside the quotes glues a
>   newline onto the token → false `403`), or use
>   `Invoke-WebRequest -Headers @{ "x-events-token" = $t }` which can't be mangled.

### 11b. Recipes for each built-out (live) service

These **seven** service types have live clients today (PRODUCTION-READINESS.md §0);
the rest are cataloged but still on the mock adapter. Each recipe follows the same
shape — **Register → Inbound (platform → hub) → Enforcement (hub → platform, or the
gate) → Verify**. Every system also takes a **`category`** that drives the cascade:
give related services the same category (or link them in the matrix) so a STOP on
one covers the rest, and keep `emergency` protected.

**Twilio (SMS).** Full walkthrough in §11a. In short: register `twilio`,
`channel=sms`, `can_write_optout=true`, provide `messaging_service_sid`; wire
inbound via the per-service webhook, **Event Streams**, or **sender-report**; the
hub enforces by writing opt-outs into Twilio's Consent API.

**Telesign (SMS).** Also in §11a. **Withhold-only:** register `telesign`,
`can_write_optout=false`; point the MO callback at `/api/webhooks/telesign/<id>`;
enforcement is the **consent-check gate** in your Telesign/Anthology Reach sender.

**Constant Contact (Email).**
- *Register:* `constant_contact`, `channel=email`, `can_write_optout=true`,
  `can_write_optin=true`. Creds: `api_key` (client ID), `client_secret`,
  `access_token`, `refresh_token`.
- *Get the credentials (OAuth 2.0):*
  1. **API Key + Secret** — at [developer.constantcontact.com](https://developer.constantcontact.com/)
     → **My Applications → New Application**. Copy the **API Key** (→ `api_key`),
     **Generate Secret** (→ `client_secret`, shown once), and set a **Redirect URI**
     (e.g. `https://localhost` for a manual token grab).
  2. **Access + Refresh tokens** — run the **authorization-code** flow. Open in a
     browser (the scopes matter — see the warning below):
     ```
     https://authz.constantcontact.com/oauth2/default/v1/authorize?client_id=<API_KEY>&redirect_uri=<REDIRECT_URI>&response_type=code&scope=account_read+contact_data+offline_access&state=setup
     ```
     Authorize, copy the `code` from the redirect, then exchange it (code is single-use):
     ```
     curl -X POST "https://authz.constantcontact.com/oauth2/default/v1/token" \
       -u "<API_KEY>:<SECRET>" \
       -d "code=<AUTH_CODE>&redirect_uri=<REDIRECT_URI>&grant_type=authorization_code"
     ```
     Paste the returned `access_token` and `refresh_token` into the hub, **Save**,
     then **Test connection**. (PowerShell: use `curl.exe` and backtick line
     continuations.)
- *⚠ Required scopes* — the token **must** carry all three, or Test connection
  fails on one check:
  - `account_read` → the reachability probe (`GET /account/summary`). **Missing
    this is the #1 gotcha:** the token authenticates and topology discovery passes,
    but "Adapter reachable" returns **403** — because it was authorized without
    `account_read`. Re-run the authorize step above with all three scopes and
    replace **both** tokens.
  - `contact_data` → topology (`/contact_lists`), opt-out reads/writes, and polling (`/contacts`).
  - `offline_access` → issues the **refresh token** for unattended operation. Without it you get an access token but no refresh token, and the connection dies at the first ~hourly expiry.
- *Inbound:* **poll** (no webhook). Provide `client_secret` + `refresh_token` so the
  hub refreshes the short-lived OAuth token unattended (it rotates on each refresh);
  it pulls unsubscribes on `POLL_INTERVAL_MINUTES`, or on demand via `POST /api/poll/<id>`.
- *Enforcement:* writable — the hub writes list unsubscribe/subscribe; the
  reconciler reads back by poll.
- *Verify:* unsubscribe in Constant Contact → appears in the hub after the next
  poll; push a hub opt-out → the contact is unsubscribed in Constant Contact.

> **Troubleshooting `401` on topology discovery (≠ the `403` above).** A **403**
> is a *scope* problem (`account_read`); a **401** is a *token* problem — the
> access token is invalid/expired and the adapter's one automatic refresh
> couldn't fix it. The refresh **silently gives up** (the 401 surfaces) when
> `client_secret` or `refresh_token` isn't stored, or when the refresh token is
> stale — CC access tokens last ~24h and CC **rotates the refresh token on every
> refresh**. Most common causes, in order:
> 1. **No refresh token was ever issued** — the grant lacked **`offline_access`**.
>    You get an access token that works for ~24h, then it expires with nothing to
>    refresh from → `401` on everything (discovery included). This is the usual one
>    if you re-authorized with only `account_read + contact_data` to fix the 403.
> 2. **`refresh_token` or `client_secret` not stored** → refresh can't run.
> 3. **Refresh token stale** — rotated away by a prior refresh whose persist didn't
>    stick, expired from inactivity, or the app authorization was revoked in CC.
>
> **Confirm:** run **Test connection** — `no access_token configured` (nothing
> stored) vs `invalid or expired token (401) — check client_secret/refresh_token`
> (present but refresh failing) — and check that `access_token`, `refresh_token`,
> and `client_secret` are all stored for the system.
> **Fix:** re-authorize with **all three** scopes (`account_read contact_data
> offline_access`) and replace **both** tokens; `offline_access` is what makes CC
> return a refresh token in the first place.

**Twilio SendGrid (Email).**
- *Register:* `sendgrid`, `channel=email`, `can_write_optout=true`,
  `can_write_optin=true`. Creds: `api_key` (`SG.…`) and `event_webhook_key`.
- *Inbound:* in SendGrid enable the **Signed Event Webhook**, copy its Base64 ECDSA
  (P-256) verification key into `event_webhook_key`, and set the webhook URL to
  `https://<hub>/api/webhooks/sendgrid/<id>` (unsubscribe / spamreport /
  group-(un)subscribe; signature- and timestamp-verified in real time).
- *Enforcement:* writable — the hub writes suppression groups.
- *Verify:* click unsubscribe on a SendGrid email → arrives at the hub immediately;
  push a hub opt-out → the recipient is suppressed in SendGrid.

**Amazon SNS / End User Messaging (SMS).**
- *Register:* `amazon_sns`, `channel=sms`, `can_write_optout=false`,
  `can_write_optin=true`. Creds: `access_key_id`, `secret_access_key`, `region`.
  Use an IAM principal scoped to SNS SMS actions only.
- *Inbound:* **poll** — the hub reads a number's status via
  `CheckIfPhoneNumberIsOptedOut` (recipients opt out by texting STOP, which SNS
  handles natively).
- *Enforcement — note the asymmetry:* the hub **cannot force an opt-out into SNS**
  (no such API), only **re-opt-in** via `OptInPhoneNumber`. So an opt-out that
  originated on *another* platform can't be pushed to SNS — to honor it on SNS
  sends, have your **SNS send path call the consent-check gate** (treat the
  opt-out-write direction as withhold-only). SNS-native STOPs are read back by poll.
- *Verify:* text STOP to the SNS number → reflected in the hub after poll; a hub
  re-opt-in → `OptInPhoneNumber` clears it.

**Amazon SES (Email).**
- *Register:* `amazon_ses`, `channel=email`, `can_write_optout=true`,
  `can_write_optin=true`. Creds: `access_key_id`, `secret_access_key`, `region`,
  optional `configuration_set`.
- *Inbound:* **poll** — the hub reads the SESv2 **account-level suppression list**.
- *Enforcement:* writable — the hub **adds** an address on opt-out (Reason
  `COMPLAINT`) and **removes** it on opt-in; the reconciler reads the list.
- *Verify:* add/remove in SES → reflected after poll; push a hub opt-out → the
  address appears on the SES suppression list.

**Azure Communication Services (SMS).**
- *Register:* `azure_communication`, `channel=sms`, `can_write_optout=true`,
  `can_write_optin=true`. Creds: `connection_string`, `from_number`.
- *Inbound:* **poll** — the hub checks the **Opt-Out Management** list (scoped to
  `from_number`).
- *Enforcement:* writable — **add** (opt-out) / **remove** (opt-in), scoped to
  `from_number`. (ACS *email* is a separate surface, not covered by this adapter.)
- *Verify:* opt-out on the ACS list → reflected after poll; push a hub opt-out →
  the number is added to the ACS opt-out list for that sender.

> **Poll cadence.** The poll-based services above (Constant Contact, SNS, SES, ACS)
> ingest on `POLL_INTERVAL_MINUTES`; lower it for tighter convergence, or trigger
> `POST /api/poll` / `POST /api/poll/<id>` on demand. The sync-lag report flags any
> opt-out that hasn't converged within the regulatory window.

### 11b-i. Live-validation runbook — Modern Campus Message (Signal Vine)

The Signal Vine adapter is **built but unproven** (HMAC signer + per-program poll,
verified only at the unit layer). It has **one known risk**: the contact JSON shape
isn't in the vendor's OpenAPI spec, so the phone/timestamp **field mapping is a
best-guess** (`extractPhone`/`extractTimestamp`). This runbook proves it against a
real account and corrects that mapping if needed.

**Credentials to get** (from the Modern Campus account admin — for CSI, the Augusoft
Lumens owner): org **token + secret** (portal → *My Account → Security → API*) and
the **Account ID**. Enter them as the `token`, `secret`, `account_id` credentials on
the service.

**Steps**
1. **Register + Test connection.** Add the service (type *Modern Campus Message*),
   store the three credentials, and run **Test connection**. A pass means the HMAC
   signer + clock are correct (`probe` = `GET /v1/accounts/{id}`). A **401** = bad
   token/secret **or host clock skew** (signatures are valid only 90 s).
2. **Poll and inspect.** Trigger `POST /api/poll/<system-id>`. Then check the logs:
   - If opt-outs come back → the mapping is correct. ✅
   - If the log shows **`signal_vine_no_phone_extracted`** (a page had inactive
     contacts but no phone was extracted), the guessed field names are wrong — the
     warning includes **`sample_keys`** (field names only, no PII). Update the `KEYS`
     / nest list in `extractPhone` (and `extractTimestamp`) to the real field, and
     re-poll.
3. **Prove ingest end-to-end.** Opt a test contact out in Modern Campus (mark
   inactive / reply STOP), poll, and confirm the hub records an **opt-out** for that
   phone and it appears in the sync-lag report as converging.
4. **Confirm scope + cadence with the vendor** (the open questions from the research
   page): is `active` writable via `POST /participants` to push a hub opt-out back;
   any rate limits / recommended poll cadence; does `active=false` capture *all*
   opt-out types. If the write-back is confirmed, enable it (currently refused —
   withhold-only).

**Done when:** Test connection passes, a real opt-out ingests correctly, and the
field mapping is confirmed (no `signal_vine_no_phone_extracted` warnings on a page
that has inactive contacts).

### 11c. Pattern shortcut for any pair
- **Both writable (e.g. SendGrid + Mailchimp):** register both (pattern A), wire
  each inbound webhook, done — the hub writes opt-outs into both and ingests from
  both. No sender changes required.
- **Any withhold-only platform (Telesign, Mongoose, email-to-SMS gateway):** the
  sender for *that* platform must call the gate; there is no way around it, because
  the hub has nothing to write to.
- **Mixed stack:** writable platforms are enforced by the hub's outbound writes;
  withhold-only platforms are enforced by their senders calling the gate. Inbound
  ingest (webhook/Event Streams/report/poll/export) is wired per platform so a STOP
  anywhere reaches the hub and cascades to the rest.
