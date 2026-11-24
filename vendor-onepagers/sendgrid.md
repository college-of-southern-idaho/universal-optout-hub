# Connecting **Twilio SendGrid** to the College Consent Hub

*For a vendor who sends email to our students/staff via your **own SendGrid
account**. One-time setup on your side — we do not need your SendGrid API key.*

## What we need from you
- The **sending domain(s)** you use for us, and (for the webhook option) your Signed
  Event Webhook **verification key** (a *public* ECDSA key — safe to share; it only
  lets us verify your webhook is genuine).
- **Not** your SendGrid API key.

## What we give you
- Your **system id** and a **service API key**. Our hub base URL.

## Step 1 — Forward opt-outs to us (pick ONE)

**Preferred — SendGrid Signed Event Webhook** (SendGrid posts unsubscribe /
spam-report / group-unsubscribe events to us):
1. SendGrid → **Settings → Mail Settings → Event Webhook** (enable **Signed Event
   Webhook**), set the HTTP POST URL to:
   ```
   https://<hub-base-url>/api/webhooks/sendgrid/<your-system-id>
   ```
2. Select the **unsubscribe / group unsubscribe / spam report** events.
3. Send us the **verification key** shown in that screen (public key).

**Or — Report API:** when someone unsubscribes on your side, POST it to us:
```
POST https://<hub-base-url>/api/v1/consent/report
X-API-Key: <your key>
{ "system": "<your-system-id>", "value": "student@example.edu", "direction": "opt_out", "source": "unsubscribe" }
```

## Step 2 — Check before sending
```
POST https://<hub-base-url>/api/v1/consent/check
X-API-Key: <your key>
{ "system": "<your-system-id>", "channel": "email", "identities": ["student@example.edu"] }
```
Do **not** send to anyone marked `suppress`; **fail closed** if we're unreachable.

**Example check response** — one result per identity; act on `decision`:
```json
{ "results": [
  { "identity": "student@example.edu", "normalized": "student@example.edu", "decision": "suppress",
    "state": "opted_out", "reason": "explicit opt-out on record for this system",
    "as_of": "2026-09-10T17:04:00Z", "advisory": null } ] }
```
`decision` = `allow` | `suppress` | `error`. Full request/response contract:
**Vendor Integration Guide → Endpoint reference**.

## Notes
- Emails **lowercased**.
- Questions / to receive your key: **your hub administrator — your-admin@example.edu**.
