# ADR 0004 — Verification working notes

**Tracks:** the §5 verification items of [ADR 0004](ADR-0004-consent-check-api.md), to be resolved before implementing the consent-check API.
**Status:** In progress
**Last updated:** July 2026

Legend: ✅ resolved · 🟡 decision needed (yours) · 🔴 vendor confirmation needed

---

## Item 1 — Per-platform pre-send hook feasibility 🟡🔴

**Question.** Can each sending service enforce a suppression the hub knows about? The consent-check API only helps a platform whose send path can make an outbound HTTP call and act on the answer. Assessed adapter by adapter, as §5.1 requires.

**Finding.** Feasibility is determined by two axes, one from the catalog and one from the deployment:

1. **Does the platform keep a caller-writable suppression list?** (`can_write_optout`, from `catalog.ts`)
2. **Do we control the send path?** (deployment fact — is it our code, or a vendor's SaaS send engine?)

This yields three enforcement classes:

| Class | Platforms | Enforcement path |
|---|---|---|
| **A. Writable list** (30 types) | sendgrid, constant_contact, mailchimp, hubspot, attentive, klaviyo, all CPaaS (vonage, sinch, infobip, bird, plivo, telnyx, bandwidth, amazon_sns, azure_communication), all ESPs, transactional email, … | **PUSH** — hub writes the opt-out into the platform's own list (roadmap item 6). Native enforcement thereafter; the consent-check API is optional defense-in-depth, **not** required. |
| **B. Withhold-only, we own the send path** | **twilio (custom texting app)**, **email_sms_gateway** | **CONSENT-CHECK API (ADR-0004)** — our sending code calls the hub before sending. This is exactly ADR-0004's home turf; viable to build now. |
| **C. Withhold-only, vendor owns the send path** | **telesign (Anthology Reach)**, **mongoose_cadence**, **modern_campus_message** | **GAP.** No writable list to push to, and we can't inject a pre-send call into the vendor's SaaS send engine. See below. |

**The Class C residual gap (important).** For these platforms, a *natively-originated* opt-out is enforced by the vendor's own STOP handling — fine. But a *propagated* opt-out (the consumer said STOP on some **other** platform) cannot be enforced on a Class C platform by any current mechanism: withhold-only means they accept no external suppression, and we can't hook their sender. This is the sharp edge of the whole system, and it lands squarely on **the org's actual initial targets** (Anthology Reach especially).

**Resolution / next actions.**
- Class A (30): ✅ enforcement path is settled (push). The consent-check API is optional for them; do not gate their onboarding on it.
- Class B (2): ✅ consent-check API is the path — **now implemented** (backend + admin UI). Design spec and as-built notes: [ADR-0004-class-b-api-design.md](ADR-0004-class-b-api-design.md). Reference sender integrations for **both** Class B senders are provided — the custom Twilio app (`optout-hub/examples/twilio-sender/`) and the email-to-SMS gateway (`optout-hub/examples/email-sms-gateway-sender/`) — sharing one fail-closed gate with a hub-synced suppression cache (fail-to-cache on outage). Wiring these references into the real production senders remains.
- Class C (3): 🔴 **vendor conversations required** — question checklists drafted in [ADR-0004-class-c-vendor-questions.md](ADR-0004-class-c-vendor-questions.md). For each, confirm exactly one of:
  1. Can the vendor **accept an external suppression** (import/API) so we can push a propagated opt-out? (If yes → moves to Class A.)
  2. Does the vendor expose a **pre-send webhook/hook** we can point at the consent-check API? (If yes → moves to Class B.)
  3. If neither: document that **propagated opt-outs cannot be enforced on this platform**, and decide the compliance response (e.g., restrict the platform to identities with a positive local opt-in, or accept and document the residual risk).
  - This subsumes the still-open ADR-0002 §6 Telesign item (does the inbound callback carry the receiving code; does Telesign expose *any* suppression surface).

---

## Item 2 — Fail-open vs. fail-closed default ✅

**Recommendation.** **Fail-closed, and no blind fail-open — ever.** If the hub is unreachable or errors, the caller treats the identity as suppressed (or holds/queues the send). Rationale is the liability asymmetry (DESIGN §2.4): over-suppression carries no statutory penalty, under-suppression does; the safe degradation is silence.

The *only* permitted "keep sending during an outage" mode is **fail-to-cache**: a caller that maintains a hub-synced local suppression list may fall back to that last-known list — which is itself a suppression check, not a blind allow. A bare fail-open (send everything when the hub is down) is not offered as a configuration option, because it converts a hub outage into a compliance incident.

✅ **Accepted:** fail-closed default, fail-to-cache permitted, blind fail-open disallowed.

---

## Item 3 — Check-audit retention ✅

**Context.** Logging every pre-send check is high-volume and PII-bearing (phone/email + decision). Retaining all of it for the full TCPA statute (DESIGN §14: ~4 years federal) is both a storage and a privacy-exposure problem.

**Recommendation — split by evidentiary value:**

| Record | Value | Proposed retention |
|---|---|---|
| **`suppress` decisions** (a send was withheld) | High — direct evidence for the § 227(c)(5) affirmative defense ("we consulted and withheld") | Retain per statute (~4 yr), in a durable audit store |
| **`allow` decisions** (high-volume, individually low value) | Low individually; useful in aggregate | Short hot window (e.g. 30–90 days) or aggregate counts only |

Keep this in a **dedicated table**, not the consent `audit_log`, so its volume and retention are governed independently.

✅ **Accepted and built:** split retention — `suppress` ≈ statute (~4 yr), `allow`/`error` ≈ 30–90 days, in a dedicated table. The prune is implemented in `services/retention.ts` (`pruneConsentChecks`): two indexed DELETEs in a transaction, audited with per-class counts, driven by `CONSENT_CHECK_RETAIN_SUPPRESS_DAYS` (default 1461) and `CONSENT_CHECK_RETAIN_OTHER_DAYS` (default 90); exposed at `POST /api/consent-checks/prune` (admin) plus an admin card in the Audit-log tab, and pure-unit tested. *(Confirm the exact windows with counsel before go-live; the defaults are placeholders, the split and the dedicated table are settled.)*

---

## Item 4 — Rate limits and batch size ✅ (proposed defaults)

- **Batch endpoint:** accept up to **1,000 identities per request** (bounds payload size and query cost; senders check a campaign list in a few batched calls rather than one call per message).
- **Per-key rate limit:** built — a per-key token bucket, hub-wide default 60 req/s burst (`CONSENT_CHECK_RATE_LIMIT_PER_SEC`), configurable per key (`0` = unlimited); `429` + `Retry-After` on breach. Tune the default once we see a real sender's volume.
- **Guidance to integrators:** batch-check a campaign's recipients up front; do not make a synchronous per-message call at fan-out time.

Engineering defaults; no external dependency. Revisit against the first live sender's real volume.

---

## Item 5 — `unknown → allow`, and "allow ≠ consent" wording ✅

**Resolution.** `unknown → allow` is correct for the default **blocklist** posture (send unless a revocation is on record) — a first-contact or transactional send must not be blocked merely because the hub has never heard of the identity. But the response must make the limit explicit:

- **Never return a bare boolean.** The response always carries `{ decision, state, advisory }`.
- When `state` is `unknown` (or otherwise not a positive local opt-in), include an advisory to the effect of: *"No suppression on record. This is not a consent grant; the sender remains responsible for its own lawful basis to contact."* This keeps `allow` from being read as "the hub cleared this send," which would recreate the manufactured-consent failure the opt-in gate (DESIGN §11) exists to prevent.

**Optional stricter mode.** Offer an **allowlist** posture per deployment (`unknown → suppress`; send only with a positive opt-in on record). Default remains **blocklist**, because allowlist would block legitimate first-contact/transactional messaging — a deployment opts in deliberately.

✅ **Accepted:** blocklist default with the advisory field; allowlist available as an opt-in per-deployment mode.

---

## Summary of what's blocking implementation

- **Built (PRs #11 backend, #12 admin UI):** the consent-check API against **Class B** platforms (custom Twilio texting, email-to-SMS gateway) — the clean proof case. Per-key rate limiting, the audit-retention prune, reference sender integrations for both Class B senders, and the fail-to-cache suppression feed are now built too. Remaining: wire the reference gate into the real production senders.
- **Decided (✅):** items 2, 3, 5 accepted as recommended. Items 2 and 3 still warrant a counsel check on the exact retention windows before go-live, but the design is settled.
- **Needs vendor conversations (🔴):** the three **Class C** platforms, Anthology Reach/Telesign first. This is the highest-risk unknown and determines whether cross-platform opt-out is enforceable on the org's own initial targets.
