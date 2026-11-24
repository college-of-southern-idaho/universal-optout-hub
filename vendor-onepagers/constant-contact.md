# Connecting **Constant Contact** to the College Consent Hub

*For a vendor who sends email to our students/staff via your **own Constant Contact
account**. One-time setup on your side.*

> If the **college** owns the Constant Contact account, we connect directly (OAuth,
> no vendor action needed). This page is for when a **vendor** owns it.

## What we need from you
- The **sending domain / from-addresses** you use for us.
- **Not** your Constant Contact login or API secret.

## What we give you
- Your **system id** and a **service API key**. Our hub base URL.

## Step 1 — Report opt-outs to us
Constant Contact doesn't push unsubscribes to an external system, so when a contact
**unsubscribes**, send it to us:
```
POST https://<hub-base-url>/api/v1/consent/report
X-API-Key: <your key>
{ "system": "<your-system-id>", "value": "student@example.edu", "direction": "opt_out", "source": "unsubscribe" }
```
(You can send these one-by-one as they happen, or as a periodic batch — one call per
opt-out.)

## Step 2 — Check before sending
Before adding recipients to a send, ask us:
```
POST https://<hub-base-url>/api/v1/consent/check
X-API-Key: <your key>
{ "system": "<your-system-id>", "channel": "email", "identities": ["student@example.edu"] }
```
Exclude anyone marked `suppress`; **fail closed** if we're unreachable.

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
