# Connecting **Amazon SNS / End User Messaging** to the College Consent Hub

*For a vendor who sends SMS to our students/staff via your **own AWS account**.
One-time setup on your side — we do not need your AWS keys.*

> If the **college** owns the AWS account, we connect directly (read the opt-out
> status via the AWS API). This page is for when a **vendor** owns it.

## What we need from you
- The **origination numbers / sender IDs** you use for us.
- **Not** your AWS access keys.

## What we give you
- Your **system id** and a **service API key**. Our hub base URL.

## Step 1 — Report opt-outs to us
Recipients opt out by texting **STOP** (AWS records it on your account). Forward each
opt-out to us:
```
POST https://<hub-base-url>/api/v1/consent/report
X-API-Key: <your key>
{ "system": "<your-system-id>", "value": "+12085550123", "direction": "opt_out", "source": "STOP" }
```
(You can read opted-out numbers with `CheckIfPhoneNumberIsOptedOut` / your opt-out
list and report any new ones on a schedule.)

## Step 2 — Check before sending
```
POST https://<hub-base-url>/api/v1/consent/check
X-API-Key: <your key>
{ "system": "<your-system-id>", "channel": "sms", "identities": ["+12085550123"] }
```
Do **not** send to anyone marked `suppress`; **fail closed** if we're unreachable.
This honors opt-outs made on *other* college channels, which AWS's own STOP list
won't have.

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
