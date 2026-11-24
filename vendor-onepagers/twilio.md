# Connecting **Twilio** to the College Consent Hub

*For a vendor who sends SMS to our students/staff via your **own Twilio account**.
One-time setup on your side — we do not need your Twilio Auth Token or any secret.*

## What we need from you (identifiers, not secrets)
- Your Twilio **Account SID** (`AC…`) and **Messaging Service SID(s)** (`MG…`).
- **Not** your Auth Token or API Key secret.

## What we give you
- Your **system id**, an **Event Streams token**, and a **service API key**.
- Our hub base URL.

## Step 1 — Forward opt-outs to us (pick ONE)

**Preferred — Twilio Event Streams** (streams a *copy* of inbound messages to us,
in parallel to your own webhook, so your app is unaffected):
1. Twilio Console → **Event Streams** → create a **Sink** (type: *Webhook*):
   ```
   https://<hub-base-url>/api/webhooks/twilio-events/<your-system-id>?token=<TOKEN>
   ```
2. Create a **Subscription** to `com.twilio.messaging.inbound-message.received` → that sink.
   - One account-level subscription covers all your Messaging Services; we route by Messaging Service SID.
   - Auth is the `?token=` we provide — no Twilio credential of yours is shared.

**Or — Report API** (if you'd rather not use Event Streams): when your app receives a
**STOP**, POST it to us:
```
POST https://<hub-base-url>/api/v1/consent/report
X-API-Key: <your key>
{ "system": "<your-system-id>", "value": "+12085550123", "direction": "opt_out", "source": "inbound STOP" }
```

## Step 2 — Check before sending
Before sending, ask us whether the recipient may be contacted:
```
POST https://<hub-base-url>/api/v1/consent/check
X-API-Key: <your key>
{ "system": "<your-system-id>", "channel": "sms", "identities": ["+12085550123"] }
```
Do **not** send to anyone the response marks `suppress`; **fail closed** if we're
unreachable. This is what lets you honor an opt-out made on a *different* college
channel (Twilio's own STOP only covers STOPs sent to your numbers).

**Example check response** — one result per identity; act on `decision`:
```json
{ "results": [
  { "identity": "+12085550123", "normalized": "+12085550123", "decision": "suppress",
    "state": "opted_out", "reason": "explicit opt-out on record for this system",
    "as_of": "2026-09-10T17:04:00Z", "advisory": null } ] }
```
`decision` = `allow` | `suppress` | `error`. Full request/response contract:
**Vendor Integration Guide → Endpoint reference**.

## Notes
- Phone numbers in **E.164** (`+12085550123`).
- Questions / to receive your token + key: **your hub administrator — your-admin@example.edu**.
