# Connecting **Azure Communication Services (ACS)** to the College Consent Hub

*For a vendor who sends SMS (or email) to our students/staff via your **own Azure
Communication Services resource**. One-time setup on your side — we do not need your
connection string.*

> If the **college** owns the ACS resource, we connect directly (read/write the ACS
> Opt-Out Management list). This page is for when a **vendor** owns it.

## What we need from you
- The **sender number(s)** (`from`) you use for us.
- **Not** your ACS connection string or access key.

## What we give you
- Your **system id** and a **service API key**. Our hub base URL.

## Step 1 — Report opt-outs to us
When someone opts out (STOP), or you add them to the ACS opt-out list, forward it:
```
POST https://<hub-base-url>/api/v1/consent/report
X-API-Key: <your key>
{ "system": "<your-system-id>", "value": "+12085550123", "direction": "opt_out", "source": "STOP" }
```
(ACS can raise an **SMS Received / Opted-Out** event via Event Grid → a small
function can call this automatically.)

## Step 2 — Check before sending
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
- Phone numbers in **E.164** (`+12085550123`). ACS email is a separate surface — tell
  us if you send email too.
- Questions / to receive your key: **your hub administrator — your-admin@example.edu**.
