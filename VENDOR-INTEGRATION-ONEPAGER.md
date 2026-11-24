# Integrating with the College Consent Hub — Vendor Guide

*A setup guide for vendors who send SMS or email to our students/staff on the
college's behalf. Setup is one-time, on your side — **we do not need your account
credentials or secrets.***

This is the **master guide**. Hand a vendor the **per-platform page** for whatever
they send through (see the index at the bottom); every platform also supports the
**universal method** described here.

---

## Why we're asking

The college is legally required (TCPA / CAN-SPAM) to honor a person's opt-out
across **every** system that messages them — and that obligation is the college's,
not yours. If your platform sends on our behalf, we need two things:

1. **Tell us when someone opts out** (texts STOP, unsubscribes); and
2. **Check with us before sending**, so you don't message someone who opted out on
   a different college channel.

---

## The universal method (works with ANY platform)

Two HTTPS calls, regardless of what you send through. Authenticate with a **service
API key we issue you** (`X-API-Key` header). No credentials of yours are shared.

**1. Report an opt-out** — call this whenever someone opts out on your side:
```
POST https://<hub-base-url>/api/v1/consent/report
X-API-Key: <the key we issued you>
Content-Type: application/json

{ "system": "<your-system-id>", "value": "+12085550123",
  "direction": "opt_out", "source": "inbound STOP" }
```

**2. Check before sending** — call this before each send (or sync it into a local
cache):
```
POST https://<hub-base-url>/api/v1/consent/check
X-API-Key: <the key we issued you>
Content-Type: application/json

{ "system": "<your-system-id>", "channel": "sms",
  "identities": ["+12085550123", "student@example.edu"] }
```
The response returns a `decision` per identity — **`allow`** or **`suppress`**. **Do
not send** to anyone marked `suppress`, and **fail closed** (don't send) if the hub
is unreachable.

That's the whole integration for most platforms. Some platforms can *also* push
opt-outs to us automatically (so you may not even need call #1) — see your
per-platform page.

---

## Endpoint reference

Both endpoints use HTTPS + JSON and authenticate with your **`X-API-Key`**. Values
you send are normalized (phone → E.164, email → lowercased) before matching.

### `POST /api/v1/consent/report` — report an opt-out (or opt-in)

**Request fields**

| Field | Required | Values | Notes |
|---|---|---|---|
| `system` | yes | your system id | must match the system your API key is scoped to |
| `value` | yes | phone **or** email | raw is fine; we normalize |
| `direction` | yes | `opt_out` \| `opt_in` | vendors normally send `opt_out` |
| `occurred_at` | no | ISO-8601 timestamp | defaults to now |
| `source` | no | free text | provenance note, e.g. `"inbound STOP"` |

**Success (200):** `{ "ok": true, "normalized": "+12085550123", "direction": "opt_out" }`
Errors: `400` missing/invalid field · `401` bad/missing key · `403` key not scoped to `system`.

### `POST /api/v1/consent/check` — ask before sending

**Request fields:** `system` (yours), `channel` (`sms` \| `email`, matching the
identities), `identities` (array of **1–1000** phones/emails).

**Success (200)** — one result per identity:
```json
{
  "results": [
    { "identity": "+12085550123", "normalized": "+12085550123",
      "decision": "suppress", "state": "opted_out",
      "scope": { "system": "your-system-id", "channel": "sms" },
      "reason": "explicit opt-out on record for this system",
      "as_of": "2026-09-10T17:04:00.000Z", "advisory": null },
    { "identity": "+12085550199", "normalized": "+12085550199",
      "decision": "allow", "state": "unknown",
      "scope": { "system": "your-system-id", "channel": "sms" },
      "reason": "no suppression on record", "as_of": null,
      "advisory": "Not a consent grant; the sender remains responsible for its own lawful basis to contact." }
  ]
}
```

**Response fields**

| Field | Meaning |
|---|---|
| `identity` | the value you sent (echoed back) |
| `normalized` | E.164 / lowercased email, or `null` if unrecognized |
| `decision` | **`suppress`** = do NOT send · **`allow`** = OK to send · **`error`** = bad identity/channel |
| `state` | `opted_out` · `suppressed` (opt-out propagated from another platform) · `opted_in` · `unknown` · `null` |
| `reason` | human-readable explanation of the decision |
| `as_of` | ISO-8601 time of the recorded state, or `null` |
| `advisory` | present only when we have no record — a reminder that `allow` is not a consent grant |

**How to act on it:** send only where `decision` is `allow`; treat **`suppress`** and
**`error`** as do-not-send; **fail closed** (don't send) if the call errors or times out.

---

## Identifiers vs. secrets — what we do and don't need

- We need **identifiers** — e.g. your Twilio `Account SID` (`AC…`) / `Messaging
  Service SID` (`MG…`), a sending domain, or a sender number. These are *not
  secrets* and are safe to share, like an account number. They let us route your
  events.
- We do **NOT** need your **secrets** — Auth Tokens, API secrets, passwords, or
  admin access to your account.

---

## Practical notes

- **Identity format:** phone numbers in **E.164** (`+12085550123`), emails
  **lowercased**, so they match our records.
- **This is not a data-sharing arrangement** — we receive opt-out signals plus the
  identifiers needed to honor them; nothing more.
- **Message categories:** most of what you send is *transactional* (account/service
  messages) — these are generally not suppressed by a marketing opt-out. Tell us if
  you also send *marketing/promotional* messages, which are.

---

## Per-platform guides

| Platform you send through | Guide |
|---|---|
| **Twilio** (SMS) | [vendor-onepagers/twilio.md](vendor-onepagers/twilio.md) |
| **Twilio SendGrid** (email) | [vendor-onepagers/sendgrid.md](vendor-onepagers/sendgrid.md) |
| **Telesign** (SMS) | [vendor-onepagers/telesign.md](vendor-onepagers/telesign.md) |
| **Constant Contact** (email) | [vendor-onepagers/constant-contact.md](vendor-onepagers/constant-contact.md) |
| **Amazon SNS / End User Messaging** (SMS) | [vendor-onepagers/amazon-sns.md](vendor-onepagers/amazon-sns.md) |
| **Amazon SES** (email) | [vendor-onepagers/amazon-ses.md](vendor-onepagers/amazon-ses.md) |
| **Azure Communication Services** (SMS/email) | [vendor-onepagers/azure-communication-services.md](vendor-onepagers/azure-communication-services.md) |
| **Any other platform** | Use the **universal method** above (report + check). |

---

## To get started

Contact the college IT / Solutions Team to receive your **system id**, a **service
API key**, and any platform-specific token:

**your hub administrator — your-admin@example.edu**
