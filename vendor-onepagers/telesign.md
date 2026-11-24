# Connecting **Telesign** to the College Consent Hub

*For a vendor who sends SMS to our students/staff via your **own Telesign account**
(directly or through Anthology Reach). One-time setup on your side.*

## What we need from you
- The **sender IDs / phone numbers** you use for us.
- For the callback option only: confirmation you can point Telesign's MO callback at
  our URL. (Telesign has **no caller-writable suppression list**, so opt-outs are
  enforced by *withholding sends* — see Step 2, which is the important one.)

## What we give you
- Your **system id** and a **service API key**. Our hub base URL.

## Step 1 — Forward opt-outs to us (pick ONE)

**Telesign MO (mobile-originated) callback** — point your Telesign Messaging MO
callback for STOP/START at:
```
https://<hub-base-url>/api/webhooks/telesign/<your-system-id>
```
(If we verify the callback signature we'll coordinate the shared key with you.)

**Or — Report API** (simplest, no shared secret): when you receive a **STOP**, POST
it to us:
```
POST https://<hub-base-url>/api/v1/consent/report
X-API-Key: <your key>
{ "system": "<your-system-id>", "value": "+12085550123", "direction": "opt_out", "source": "STOP" }
```

## Step 2 — Check before sending (required)
Because Telesign can't hold a suppression list we write to, **the only way an
opt-out is honored is if you check us before sending:**
```
POST https://<hub-base-url>/api/v1/consent/check
X-API-Key: <your key>
{ "system": "<your-system-id>", "channel": "sms", "identities": ["+12085550123"] }
```
Do **not** send to anyone marked `suppress`; **fail closed** if we're unreachable.

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
- Questions / to receive your key: **your hub administrator — your-admin@example.edu**.
