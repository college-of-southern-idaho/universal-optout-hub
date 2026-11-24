# Connecting **Modern Campus Message** (Signal Vine) to the College Consent Hub

*Modern Campus Message is a platform the **college licenses**, so the hub connects
directly to its **API** — there's nothing for a third party to send us. Unlike the
SMS/email vendors, Modern Campus has **no send-time API**, so the hub can't gate an
individual send; enforcement is (1) **pulling** opt-outs from Modern Campus and
(2) **writing** an inactive flag for opt-outs made on other college channels.*

## What we need (from whoever administers the Modern Campus account)
- **API access enabled.** An **Account Administrator** generates an org-level
  **token + secret** in the Modern Campus web portal
  (`app.signalvine.com/sv/settings/api`). The **token** is an identifier; the
  **secret** is the signing key — treat it like a password.
- The **Account ID** and the **Program IDs** in scope (integration is per program).

## How the hub authenticates
- **HMAC-SHA256 request signing** — every request is signed with the token+secret
  over `token / verb / path / body / timestamp`; signatures are valid for 90
  seconds. No login or password is shared beyond the token+secret pair.

## Step 1 — Ingest opt-outs (the hub pulls, per program)
The hub polls each program on a schedule for contacts who have opted out (texted
**STOP** or been deactivated):
```
GET /v2/programs/<program-id>/contacts?active=false
```
The `active` flag carries opt-in status. These opt-outs flow into the hub and
**cascade to the college's other channels**, so a STOP in Modern Campus also
suppresses the person on email, other texting platforms, etc. No webhook or
per-event push is needed on the Modern Campus side — just API access.

## Step 2 — Honor opt-outs made elsewhere (the hub writes back)
Because Modern Campus has no send-time check, the way an opt-out made on a
**different** college channel is honored here is for the hub to mark the contact
inactive via the bulk contact upsert:
```
POST /v2/programs/<program-id>/participants   → set the contact active=false
```
> ⚠ **To confirm with Modern Campus before we rely on this:** is `active` writable
> through the participants upload (vs. only set by the recipient texting STOP), and
> does `active=false` actually **withhold sends**? Until confirmed, treat Step 2 as
> pending and rely on in-platform STOP + Step 1 ingest.

## Questions for Modern Campus support / the account rep
1. Can `active` be set to `false` via `POST /participants` to suppress a contact,
   and does that reliably **withhold sends**?
2. Any **rate limits** or recommended **poll cadence** on the contacts endpoint?
3. Does `active=false` capture **all** opt-out types (STOP, in-app unsubscribe,
   manual deactivation)?
4. Is the token/secret **per-account only** (one org-wide), or can it be scoped per
   program?

## Notes
- **Per-program structure** — a contact in multiple programs has a separate record
  per program; the hub pulls/writes program by program.
- Phone numbers in **E.164** (`+12085550123`); contacts are keyed by an internal
  participant ID, with phone as a profile field.
- Questions / to enable the connection: **your hub administrator — your-admin@example.edu**.
