# ADR 0004 — Class C vendor-question checklists

**Purpose.** Concrete questions to put to the account/engineering teams of the three **Class C** platforms (withhold-only *and* the vendor controls the send path), identified in [ADR-0004-verification.md](ADR-0004-verification.md) item 1. For these, a *propagated* opt-out — a consumer who said STOP on some **other** platform — cannot be enforced by any mechanism the hub has today. The point of these conversations is to establish, per vendor, which of three outcomes applies:

- **Route 1 → becomes Class A (push).** The vendor can *accept an external suppression* (API or import), so the hub pushes a propagated opt-out into the vendor's own do-not-contact list.
- **Route 2 → becomes Class B (query).** The vendor can *call out before sending* (pre-send webhook) and skip the send based on the response — which we point at the consent-check API (ADR-0004).
- **Route 3 → residual gap.** Neither is possible; we document that propagated opt-outs can't be enforced there and decide the compliance response (restrict the platform to identities with a positive local opt-in, or accept and document the risk).

Each answer below is tagged with the route it settles. **A "yes" to the Route-1 or Route-2 questions is the win** — it moves the platform out of the gap.

---

## Core questions (ask all three vendors)

### A. External suppression — *Route 1 (push)*
1. Does the platform maintain a suppression / do-not-contact / unsubscribe list we can manage?
2. **Can we add an identity (phone or email) to that suppression list via API?** Endpoint, auth model, and request/response shape?
3. Is bulk / batch suppression supported (for an initial backfill of everyone already opted out elsewhere)?
4. At what scope does a suppression apply — whole account, per sending number/short code, or per campaign/list? (We need account-wide.)
5. Once we suppress an identity, does the platform stop **all** sends to it, including already-scheduled or in-flight campaigns?
6. How quickly does a pushed suppression take effect (propagation latency on your side)?
7. Does the API confirm the suppression was applied (so we can record convergence), and can we read back the current suppression state for an identity?
8. Can a suppression be **removed** via API, and is removal gated/audited on your side? (We suppress automatically but re-enable only through a human-reviewed opt-in — we need removal to be deliberate, never a side effect.)

### B. Pre-send hook — *Route 2 (query)*
9. Does the platform support a **pre-send webhook/callback** that fires before each message and can **block or skip** the send based on our response?
10. What is the timeout / latency budget for that callback, and what does the platform do on timeout or error — send anyway (fail-open) or skip (fail-closed)? (We need the option to fail-closed.)
11. Does the callback payload include the recipient identity **and** the sending number / short code / sender ID?
12. Can the hook be enabled per account and per campaign?

### C. Inbound opt-out events — *needed regardless (propagation out + attribution)*
13. Does the platform send a webhook/callback when a consumer opts out (STOP) or opts in (START)?
14. **Does that callback include the receiving long code / short code / sender ID?** (Required for event attribution and reporting — this is the open [ADR-0002](ADR-0002-service-discovered-topology.md) §6 item.)
15. Does the payload carry the consumer's action timestamp (when they said STOP), distinct from delivery time?
16. Delivery guarantees: retries on failure? Is the webhook signed/authenticated so we can trust it?
17. Can we get a one-time **export of the current suppression list** to seed the hub at onboarding?

### D. Logistics
18. Links to API docs; is there a sandbox/test environment?
19. API rate limits relevant to bulk suppression and to inbound event volume.
20. PII handling / data residency for identities we exchange.
21. Best engineering support channel for integration questions.

---

## Telesign / Anthology Reach

**Why it's the priority.** This is the org's flagship SMS target, and [ADR-0002](ADR-0002-service-discovered-topology.md) §1 already found that *Telesign keeps no caller-writable suppression list* — it detects STOP/START and notifies the integrator by callback, and the integrator holds the list. That makes Route 1 look closed at the Telesign layer. But Anthology Reach sits **on top of** Telesign and may add its own suppression management, so the integration layer matters.

**Clarify first:** which layer do we integrate with — Telesign directly, Anthology Reach, or both? The answers below can differ by layer.

- **(Route 1)** Does **Anthology Reach** maintain a suppression list we can write to via API, even though Telesign underneath does not? If yes, Anthology Reach can move to Class A regardless of the Telesign-layer finding.
- **(Route 1)** Re-confirm with the Telesign account team: is there truly **no** API to register a suppression for a number/sender — not even a beta or account-level do-not-text list? (Confirm ADR-0002 §1 is still accurate.)
- **(Route 2)** Does Anthology Reach support a pre-send hook that can skip a send based on an external check?
- **(Route 3 trigger)** If Anthology Reach can neither accept a pushed suppression nor call out before sending: how is a consumer's opt-out that originated *elsewhere* supposed to be honored on Anthology Reach at all? (This is the exact residual-risk question we need answered on the record.)
- **(ADR-0002 §6)** Confirm the STOP/START callback includes the **receiving long code / sender ID**.

## Mongoose Cadence

Higher-ed conversational texting. Cadence typically manages opt-outs internally, so the key unknowns are whether that internal list is reachable from outside.

- **(Route 1)** Does Cadence expose an API to add/remove an identity on its opt-out/do-not-text list, and to bulk-import? Account-wide scope?
- **(Route 1)** Does Cadence honor an externally-set suppression at send time, including for staff-initiated 1:1 conversations (not just broadcast campaigns)?
- **(Route 2)** Any pre-send hook / integration that can block an outbound text based on an external check?
- **(Route 3 trigger)** If neither: can Cadence at least *import* a suppression file on a schedule (near-real-time enough to matter), or is opt-out enforcement entirely internal to Cadence?
- **(Inbound)** Webhook for STOP/START, with the receiving code and the consumer-action timestamp? Signed?

## Modern Campus Message

Higher-ed messaging platform. Same escape-route questions; confirm SMS vs. multi-channel scope.

- **(Route 1)** Suppression API — add/remove/bulk, account-wide? Applied to all message types (broadcast and transactional/triggered)?
- **(Route 2)** Pre-send webhook capable of skipping a send on an external check?
- **(Route 3 trigger)** If neither: scheduled suppression import? Or is opt-out enforcement internal only?
- **(Inbound)** STOP/START webhook with receiving-code attribution, signing, retries, and a historical suppression export for onboarding?
- **Scope check:** which channels does this deployment use (SMS, email, voice)? Channel classification follows consent semantics (email-to-SMS is SMS) per DESIGN §2.3 / §9.

---

## How to record answers

For each vendor, capture the outcome as **Route 1 / Route 2 / Route 3** and update item 1 of [ADR-0004-verification.md](ADR-0004-verification.md):
- Route 1 → reclassify to **Class A**, set `can_write_optout = true` in the catalog entry, and plan the suppression-write client (roadmap item 6).
- Route 2 → reclassify to **Class B**, plan the pre-send integration against the consent-check API.
- Route 3 → record the residual gap explicitly and take the compliance decision (restrict-to-local-opt-in vs. accept-and-document). This is a decision for the org, with counsel.
