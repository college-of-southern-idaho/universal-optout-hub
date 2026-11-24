# Universal Opt-Out Synchronization Hub
## Architecture & Design Document

**Status:** v0.3 — design plus an implemented system exercised end to end (consent engine, reconciliation loop, opt-in approval workflow, manual UI, authentication/RBAC, an admin service-configuration surface with eight live adapter clients, inbound ingest wired across webhooks/polling, and the Class B consent-check API of [ADR 0004](ADR-0004-consent-check-api.md)). Running on a hardened test instance; the remaining work is live end-to-end validation of each integration against real accounts (see PRODUCTION-READINESS.md).
**Last updated:** November 2026

---

## 1. Purpose and scope

Organizations commonly operate multiple messaging platforms simultaneously — SMS providers, email marketing tools, CRM-integrated messaging, and email-to-SMS gateways. Each platform maintains its own opt-out (suppression) list, and a consumer who revokes consent on one platform remains reachable through the others. This project provides a standalone, open-source reconciliation hub that synchronizes opt-out and opt-in state for phone numbers and email addresses across all of an organization's messaging systems.

The initial deployment context targets these platforms, though the adapter architecture is platform-agnostic:

- Anthology Reach (SMS via Telesign)
- A custom texting solution built on Twilio
- Constant Contact (email)
- Email-to-SMS gateway systems

The hub is **not** limited to that context, or to higher education: it is for any organization that must honor universal opt-out obligations across more than one messaging platform. The implemented service catalog (§9, §13.1) covers **35 SMS and email platform types** — general CPaaS, campaign SMS, higher-ed texting, email ESPs, and transactional email providers — each declaring how that platform actually handles opt-out.

Core capabilities:

1. **Opt-out synchronization** — an opt-out received on any system propagates to all (or a configured subset of) other systems, automatically and immediately.
2. **Opt-in handling** — an opt-in received on any system is always honored at that system; treating it as broader than its originating system requires explicit human confirmation.
3. **Manual management** — an employee-facing interface for viewing, setting, and auditing consent state across all systems, plus the approval queue for opt-in propagation decisions.

The hub is a **reconciliation hub**, not a system of record that platforms defer to: each platform remains authoritative for its own state, and the hub continuously detects divergence between observed platform state and policy-expected state, issuing corrective writes where possible and raising alerts where not.

## 2. Regulatory context

> **Disclaimer:** This section summarizes the regulatory motivation for design decisions. It is not legal advice, and effective dates and rule status change; deploying organizations should verify current requirements with counsel. Statements below reflect the landscape as of mid-2026.

### 2.1 TCPA (47 U.S.C. § 227)

The Telephone Consumer Protection Act restricts autodialed and prerecorded/artificial-voice calls and texts. Key properties that shape this system:

- **Private right of action** — $500 per violation (or actual damages if greater), trebled up to $1,500 for willful or knowing violations, with no aggregate cap. Each message sent after a valid revocation is a separate potential violation. **Sync lag between an opt-out event on one system and suppression on the others is the system's primary liability window.**
- **Affirmative defense (§ 227(c)(5))** — a defendant who has "established and implemented, with due care, reasonable practices and procedures" to prevent violations has an affirmative defense. The hub's append-only event log, evidence records, and approval attestations are the concrete artifacts of that defense.
- **State law not preempted (§ 227(e))** — states may impose more restrictive requirements; federal compliance alone is not always sufficient.

### 2.2 FCC 2024 TCPA Consent Order

Most provisions took effect April 11, 2025, including:

- Consumers may revoke consent by **any reasonable means**; callers may not prescribe an exclusive opt-out method.
- Opt-out requests must be honored within **10 business days** (the regulatory ceiling — this system targets near-real-time).
- Texting systems that cannot process some revocation replies must disclose that and provide alternatives.

The **"revoke-all" rule** (47 C.F.R. § 64.1200(a)(10)) — requiring that a revocation made in response to one type of message be treated as revoking consent for all calls/texts from that caller on unrelated matters — has had its effective date extended twice and is currently scheduled for **January 31, 2027**, while the FCC considers modifications. This system's cross-system opt-out propagation operationalizes that rule ahead of its effective date. Because the rule's final scope is in flux, **propagation scope is a configurable policy layer, not hardcoded behavior.**

### 2.3 Email (CAN-SPAM) and channel classification

Email marketing is governed by CAN-SPAM (10-business-day opt-out honoring, per-sender). Critically:

- **Messages delivered to a phone via an email-to-SMS gateway are text messages under the TCPA**, regardless of transport. Email-to-SMS gateway systems are classified as channel `sms` in this system's consent model.
- Consent is **channel-shaped**: consent (or its revocation) obtained on one channel does not automatically extend to another. This drives the channel-scoped design of the opt-in approval workflow (§ 11).

### 2.4 The liability asymmetry

Over-suppression (failing to message someone who consented) carries no statutory penalty. Under-suppression (messaging someone who revoked) does. The system is therefore **deliberately asymmetric**:

- **Opt-out propagation: immediate, automatic, no human in the loop.**
- **Opt-in propagation: queued, human-gated, evidence-backed.**

Re-opting a consumer in across systems without valid consent for each channel manufactures consent records the consumer never gave; every message sent on such phantom consent is a potential violation. The approval gate (§ 11) exists to prevent exactly this.

## 3. System topology: reconciliation hub

For each (identity, system) pair the hub tracks two values:

- **Observed state** — what the platform actually reports (via webhook, API poll, or export).
- **Expected state** — what the hub's policy and precedence rules say the state should be, computed from the event log.

The reconciliation loop continuously diffs observed against expected and:

- issues **corrective writes** through the system's adapter where the adapter declares write capability;
- raises an **alert to the manual interface** where divergence exists but the system is unwritable for that direction (e.g., carrier/vendor-level suppression lists that only the consumer can reverse);
- records every corrective action in the event log.

Platforms remain authoritative for themselves. The hub never assumes a write succeeded: convergence is confirmed only when the observed state (via the platform's own event delivery or next poll) matches expected.

## 4. Identity model and normalization

Identity matching failures are the dominant cause of sync errors in systems of this kind. All identity normalization happens **before** anything reaches the sync engine:

- **Phone numbers:** normalized to E.164. Raw input preserved alongside the normalized form for audit.
- **Email addresses:** explicit, documented canonicalization policy (case folding of domain; configurable handling of plus-addressing and provider-specific rules such as dots in Gmail local parts). Defaults should be conservative (treat plus-addressed variants as distinct unless configured otherwise), with the policy version recorded so historical matches can be explained.
- An **identity** may carry multiple addresses (a phone and an email known to belong to the same person) only via explicit linkage records with their own provenance; the system never infers cross-address identity on its own.

## 5. Consent data model

### 5.1 Events (append-only)

Every state change — consumer-originated, hub-originated, or operator-originated — is an immutable event:

```
consent_event {
  id
  identity_ref
  system                  -- which platform
  channel                 -- sms | email (classified by adapter, not transport)
  direction               -- opt_in | opt_out
  provenance              -- explicit | derived
  occurred_at             -- the platform's own timestamp for the event
  received_at             -- when the hub ingested it
  source_detail           -- e.g. "STOP keyword", "unsubscribe link", "operator", "reconciler"
  evidence_ref            -- nullable; required for explicit opt-ins
  sync_origin_key         -- set on hub-originated writes; used for echo suppression
  approval_ref            -- nullable; links derived opt-ins to the approval that authorized them
  actor_ref               -- nullable; operator/approver identity for manual events
}
```

### 5.2 States (materialized projection)

```
consent_state {
  identity_ref
  system
  channel
  current_state           -- see state machine, § 6
  provenance              -- explicit | derived
  as_of_event             -- the event that produced this state
}
```

The projection is **recomputable**: current state is a fold over the event log for that (identity, system), ordered by `occurred_at`. A late-arriving event with an earlier `occurred_at` triggers recomputation and, if expected state changes, new corrective writes.

### 5.3 Evidence (immutable)

For explicit opt-ins, the evidence record captures the consent language shown to the consumer, the capture method, channel, and timestamp. Evidence records are write-once. They are what gets produced in discovery if a claim lands, and what approvers review in the opt-in gate.

## 6. Per-system state machine

States for each (identity, system):

| State | Meaning |
|---|---|
| `unknown` | No record for this system. |
| `opted_in (explicit)` | Consumer opted in **at this system**; evidence attached. |
| `opted_out (explicit)` | Consumer revoked **at this system**. |
| `suppressed (derived)` | Opt-out propagated by the hub from a revocation elsewhere. |
| `opted_in (derived)` | Opt-in propagated by the hub **only via an approved review** (§ 11); carries `approval_ref`. |

Note: there is no `pending` state in the per-system machine. Pending-ness lives entirely in the approval queue; the originating system's state is never held hostage by a pending review (§ 11.1).

## 7. Precedence rules

Conflicts between events resolve by these rules, in order:

1. **A derived event never overrides an explicit event.** If a system holds an explicit opt-out, no propagated opt-in touches it — even in the most permissive configuration. Propagated opt-ins only transition systems in `unknown` or `suppressed (derived)` states.
2. **At equal provenance, opt-out beats opt-in.** Ties go to suppression.
3. **An explicit local opt-in may override a prior explicit local opt-out.** A consumer renewing consent in a channel (STOP then START is the canonical case) is honored at that system immediately. Whether it propagates further is the approval gate's question.
4. **A derived opt-in never overrides any opt-out, explicit or derived.**

When two systems disagree and the rules above don't resolve it, **suppress**.

## 8. Reconciliation loop

Per (identity, system), the loop is: ingest → fold (compute expected) → diff against observed → act. Four mechanics matter disproportionately:

### 8.1 Order by event time, not arrival time

Batch/polled sources (e.g., a daily Constant Contact export) deliver events late. Applying events in arrival order resurrects dead opt-outs. The fold over the event log sorts by `occurred_at` (the platform's own timestamp). `received_at` is retained for audit and for measuring source latency.

### 8.2 Echo suppression

When the hub writes an opt-out into System B, System B's webhook reports that same opt-out back. Hub-originated writes carry a `sync_origin_key`; the ingestion layer matches returning events against outstanding keys and records them as **confirmations of convergence**, not new consumer events. Without this, the system loops — and worse, records derived events as explicit, corrupting the provenance everything else depends on.

### 8.3 Unwritable divergence

Where expected ≠ observed but the adapter declares no write capability for that direction (e.g., a vendor STOP list that only a consumer's START can reverse), the reconciler raises an alert to the manual interface instead of retrying. The vendor/carrier suppression list is treated as an additional read-mostly "system": **the hub never attempts to send through, or write around, a vendor-level suppression even if its own state says opted-in.**

For **withhold-only** platforms the hub cannot write suppression at all; there, opt-out is enforced at send time by the sending service consulting the hub's consent-check API before sending ([ADR 0004](ADR-0004-consent-check-api.md)), not by a corrective write.

### 8.4 Sync-lag metric

The interval between an opt-out's `occurred_at` on the originating system and confirmed convergence on each target system is a **first-class operational metric** with alerting. The regulatory ceiling is 10 business days; the target is minutes.

### 8.5 Backfill onto later-added systems

Ingest-time propagation (§10) only fans out to the systems that exist when the opt-out arrives. A service registered *after* an identity opted out elsewhere has no consent-state row for that identity, so the per-state diff above never visits it — leaving a freshly added platform able to message someone already suppressed everywhere else. The reconciler therefore runs a **backfill pass**: for each identity opted out anywhere, it derives suppression on every active, in-scope system that carries no state yet. Suppression is computed by the same `deriveSuppression` path the opt-out fan-out uses, so a late-added system is suppressed exactly as an existing one would have been — and, like all suppression, enforced at send time where the adapter is unwritable.

## 9. Adapter capability contract

Each platform integration is an adapter declaring, per system:

```
adapter_capabilities {
  system_id
  channel                  -- sms | email; consent-classification, NOT transport.
                           -- Email-to-SMS gateways MUST declare channel = sms.
  event_delivery           -- webhook | poll | export
  event_timestamp_quality  -- native | arrival_only (affects ordering confidence)
  can_write_optout         -- bool
  can_write_optin          -- bool
  vendor_suppression       -- describes any platform-level suppression layer
                           -- (e.g., Twilio built-in STOP handling) and whether
                           -- it is independently readable
}
```

The reconciler consults capabilities before acting; the manual UI uses them to explain why a given divergence requires human or consumer action.

> **Adapter authors:** classify channel by *consent semantics*, not transport. A gateway that accepts email and delivers SMS is `channel: sms`. This is the most common adapter-implementation mistake and it silently breaks both the legal model and review coalescing (§ 11.3).

### 9.1 Implementation

The contract above is realized as a TypeScript `Adapter` interface (`src/adapters/contract.ts`): `observe`, `write`, `consumerAction`, `discoverTopology`, `probe`, plus the capability fields carried on the system row. Concrete details (full reasoning in **ADR 0003**):

- **Catalog.** `src/adapters/catalog.ts` is the single source of truth for the 35 known platform types — each entry declares channel (and whether it is channel-locked), capability defaults, topology granularity, and the credential fields the operator must supply. The capability defaults encode two patterns: **API-managed suppression** (the hub reads and writes opt-out, and discovers lists/pools/groups) and **withhold-only** (no caller-writable list — opt-out is enforced by withholding sends; e.g. Telesign, Twilio, the higher-ed texting tools, email-to-SMS gateways). The admin UI renders its register form straight from this catalog, so a new type is purely a catalog entry plus, when ready, a client.
- **Registry & dispatch.** `src/adapters/registry.ts` builds one adapter per active (non-archived) system, dispatching on `adapter_type` through a factory table. A type with no live client — or whose required credentials are not yet set — falls back to the mock, so every service is demoable until fully configured; once a real client exists and its credentials are present, the registry switches to it automatically on reload.
- **Live clients.** Eight types have live clients today: `SendGridAdapter` (suppression groups → topology; global suppression → opt-out read/write); `TwilioAdapter` (Account SID + Auth Token **or** API Key auth → probe; Messaging Services → sender-pool topology; opt-out **write** via the Consent Management API, but read-blind — Twilio exposes no opt-out read, so STOP/START arrive via inbound webhook, Event Streams, or a sender report); `ConstantContactAdapter` (OAuth 2.0 with refresh-on-401, verified live; poll-based unsubscribe ingestion; list opt-out/opt-in write); `TelesignAdapter` (withhold-only; MO STOP/START callback); `AmazonSnsAdapter` and `AmazonSesAdapter` (SigV4-signed — SNS opt-out read / opt-in write, SES suppression-list read/add/remove); `AzureCommunicationAdapter` (HMAC-signed opt-out check/add/remove); and `SignalVineAdapter` (Modern Campus Message / Signal Vine — withhold-only; HMAC-SHA256 request signing; poll-based opt-out ingestion per program; write refused pending vendor confirmation of the active-flag path; **built and deployed, not yet live-validated**). The remaining types use `MockAdapter`, which simulates a platform against local tables.
- **Credentials.** Stored server-side, encrypted at rest (AES-256-GCM, key derived from `APP_SECRET`), and **never returned through the API** — reads expose only metadata (which keys are set, a last-4 hint, OAuth expiry). Decryption is server-only, used by live clients at send/discovery time.

> **Current status.** The live clients implement the *outbound* half — authenticate, discover topology, and write suppression where the platform allows. The *inbound* half is now wired: signature-verified webhooks (SendGrid Event Webhook; Twilio and Telesign STOP/START), Twilio Event Streams (`/api/webhooks/twilio-events/<system>`) and a sender-report endpoint (`/api/v1/consent/report`), and poll-based ingestion (Constant Contact) all feed `ingest`, so consumer opt-outs originating on a live platform reconcile back and propagate. Remaining: exercise each path end-to-end against the real platform with live credentials (see PRODUCTION-READINESS.md).

### 9.2 Onboarding a new adapter — compatibility checklist

Platforms diverge from the hub's assumptions in predictable ways. Work this list per platform *before* committing to an integration; each item maps to a place a platform can clash with the model, and each is a real difference already seen across the eight live clients.

1. **Channel classification (consent, not transport).** Is it SMS or email *for consent purposes*? An email-to-SMS gateway is `sms`. This sets `channel`, and opt-out propagation is **channel-scoped** — a phone opt-out never cascades onto an email service or vice versa (§10, §11.3).
2. **Identity currency.** Does the platform key on the raw phone/email, or an **internal contact id** (e.g. HubSpot vid, Constant Contact contact_id)? If the latter, the adapter must map to/from the hub's normalized identity, or opt-outs won't match at query time.
3. **Outbound write (hub pushes) — and confirmability.**
   - *Writable + readable* (SendGrid, SES, ACS): full read/write; the reconciler confirms convergence.
   - *Write-only, not readable* (Twilio Consent API): a cascaded write can **never be confirmed**, so it sits as an "unconfirmed write" in the operator view indefinitely — expected, not a fault.
   - *No writable list* (Telesign, Amazon SNS opt-out): a cascade raises an **"unwritable" reconcile alert**; enforcement must come from the pre-send consent-check gate instead.
   Set `can_write_optout`/`can_write_optin` to match.
4. **Inbound learn (hub learns) — the weakest, most platform-specific leg.** How does the hub find out about a consumer opt-out? Set `event_delivery` accordingly.
   - *Signed webhook per system* — implement the signature scheme + payload mapping (Twilio STOP, SendGrid event, Telesign MO).
   - *Account-level feed needing routing* — map each event to the right system (Twilio Event Streams routes by Messaging Service SID).
   - *Poll/read* — a `pollOptOuts` implementation (SNS opt-out status, SES suppression list); opt-out latency = poll interval.
   - *Export/import only* — batch import, no live path (email-to-SMS gateway, Modern Campus).
   - *No opt-out event at the platform* — rely on the sender-report endpoint and/or the consent-check gate.
5. **Category granularity.** The hub tags a message category **per service**. A single-purpose sender (one Twilio Messaging Service per purpose) fits cleanly. If one sender **mixes** marketing and transactional, either split it into multiple hub systems (one per purpose/subscription-group) or accept coarse categorization. Note the platform may carry its own group model (SendGrid unsubscribe groups, Mailchimp audiences, HubSpot subscription types) that does not map 1:1 to hub categories.
6. **Is there an enforcement path at all?** A withhold-only platform can only be enforced via the pre-send consent-check gate. If the sender is a **third-party app you can't modify**, there is *no* enforcement path (can't check, can't write) — screen for this up front.
7. **Consent-management coordination.** Does another app already manage consent on the same sender (e.g. a third-party texting app on the same Twilio Messaging Service)? Two writers to one platform's consent state can fight or double-count.
8. **Auth & token lifecycle.** API key, HMAC, SigV4, or OAuth? OAuth needs refresh-on-401 with rotating-token persistence (built for Constant Contact via `storeRotatedCredential` — replicate the pattern).
9. **Topology discovery (optional).** Can the hub discover sender pools/groups/codes for reporting? Set `can_discover_topology`/`topology_granularity`. Attribution only — never a consent input (ADR-0002).
10. **Integration test.** Prove the write *and* the inbound path end-to-end against a sandbox with live credentials; the pure mapping/signature unit tests are not sufficient.
11. **Integration recipe.** Add a *Register → Inbound → Enforcement → Verify* recipe for the platform to [INTEGRATION.md](INTEGRATION.md) §11b, so integrators wiring the adapter into their stack have a concrete walkthrough. An adapter is not "done" until its recipe is documented.

## 10. Opt-out propagation

- Triggered by any explicit opt-out event on any system.
- Propagates per the **message-category cascade matrix** ([ADR 0005](ADR-0005-message-category-cascade.md)). Every service carries a **category** (a consent-relevant classification alongside `channel`; e.g. `marketing`, `transactional`, `emergency`). An opt-out on a source-category service suppresses the target-category services the matrix enables for that source. This operationalizes the revoke-all trajectory *while honoring category-scoped consent* — a marketing opt-out need not silence transactional or emergency messaging (the federal research; the CAN-SPAM transactional carve-out and the TCPA emergency exception). Categories are **data-driven** (a `consent_categories` registry, admin-editable), so a future FCC-exempted class is a config change, not a code change.
- **Protected categories are never suppressed.** A category flagged `protected` (emergency/safety) is never a cascade target — enforced in the engine (`deriveSuppression` skips it) regardless of the matrix, so emergency notices stay deliverable (47 C.F.R. § 64.1200(f)(4)). The matrix, categories, and per-service assignment live in `services/categories.ts` + migration 016; propagation replaced the former single "all | list of system ids" scope knob.
- **Channel-scoped.** An opt-out cascades only to systems on the **same channel** it originated on (phone→SMS, email→email) — a phone opt-out and an email opt-out are distinct identifiers and distinct consents, so they never cross. The email-to-SMS gateway is SMS by classification and stays within SMS.
- Fully automatic — no queue, no review, no human.
- Target systems transition to `suppressed (derived)`; systems already in `opted_out (explicit)` are untouched.
- Fan-out reaches the systems that exist when the opt-out arrives; systems registered **later** are caught by the reconciler's **category-aware backfill** pass (§ 8.5), which cascades from the identity's *explicit* opt-out categories only (no transitive cross-category leakage), so onboarding a new platform never reopens an already-suppressed identity.
- Any pending opt-in approval requests for the identity are **auto-canceled** (§ 11.6).

## 10a. Sending-service topology (discovered, reporting-only)

Texting platforms operate multiple long and short codes, often grouped into pools/departments (e.g., *Admissions*, *Enrollment Services*). The hub tracks this topology for reporting and attribution — **not** to drive consent decisions. Full reasoning is in **ADR 0002** (`ADR-0002-service-discovered-topology.md`), which supersedes ADR 0001; summary:

- **Discovered, not configured.** An operator registers a *system* (a service integration); the hub discovers that system's pools/groups/codes from the service and keeps them current by periodic sync. A code added to a pool at the service propagates into the hub automatically rather than being re-entered by hand.
- **Reporting/attribution only.** Topology labels which pool/department an event or code belongs to, for reporting and operational visibility. **Consent decisions never read from topology**; it is not a consent-scope authority and never triggers propagation. (Making it behavior-affecting would be a separate, deliberate future decision.)
- **Per-adapter capability.** The adapter contract declares whether a system can discover topology and at what granularity. Where a service cannot report groupings, codes are `ungrouped (source: none)` — the hub does not invent structure.
- **Optional manual annotation, with provenance.** For services whose groupings are not machine-readable, an operator may annotate codes with a grouping label stored as `source: manual`, kept separate from discovered facts (`source: <service>`). Where discovery and annotation disagree, the hub shows both rather than silently overwriting either — the same explicit/derived provenance discipline used for consent.

**Opt-out is unaffected.** Global opt-out by suppression works regardless of whether a service accepts writes. Where a service keeps a caller-writable list, the hub pushes the opt-out into it (`adapter.write()`). Where a service keeps no caller-writable list (e.g., Telesign), opt-out enforcement is "withhold sends" rather than "write a flag" — an anticipated adapter shape (`can_write_optout = false`, §9). The mechanism that makes "withhold sends" real is the **consent-check API of [ADR 0004](ADR-0004-consent-check-api.md)**: the sending service asks the hub whether an identity is suppressed before sending, failing closed if the hub is unreachable. The API is implemented for **Class B** platforms — those whose send path is our own code (custom Twilio texting, email-to-SMS gateway); wiring it into each such sender, and closing the enforcement gap for vendor-controlled withhold-only platforms (Class C), are tracked in the README roadmap and [ADR-0004-verification.md](ADR-0004-verification.md).

> **Superseded approach.** An earlier design (ADR 0001) grouped codes in the hub and auto-propagated opt-ins across a group's pool. That assumed the hub could write consent outward to sibling codes; since services like Telesign keep no caller-writable consent list, the premise failed and group-pooled automatic opt-in propagation was removed.

## 11. Opt-in handling and the approval gate

### 11.1 Local honor is unconditional

An explicit opt-in is recorded and honored at its originating system immediately — before, and regardless of, any review. Two reasons:

- **Practical:** vendor-level handling (e.g., Twilio processing START) lifts suppression instantly; gating locally would only make the hub drift from reality.
- **Legal:** the consumer renewed consent in that channel and is entitled to have it honored there.

The human decision gates only **propagation**: *"should this consent be treated as broader than the system it arrived on?"* Denial or expiry of a review is not a rollback — the opt-in simply stays scoped to where it happened, which is the legally conservative default.

### 11.2 Review trigger conditions (configurable)

To keep the queue meaningful rather than noisy, the trigger is configurable. Default: queue a review when the identity has an **explicit opt-out in at least one other system**. Options: queue when the identity exists in any state elsewhere; for identities unknown to all other systems, no review (nothing to propagate to — record locally only).

### 11.3 Channel-scoped coalescing

The coalescing key for review requests is **(identity, channel)** — not identity alone.

- Two same-channel opt-in events for one identity (e.g., START on Twilio and START via an email-to-SMS gateway) **coalesce** into a single review: append to `originating_event_refs[]`, refresh `prior_state_snapshot`, bump `version`. Together they are stronger evidence of intent than either alone.
- An SMS-origin event and an email-origin event for the same identity produce **two independent reviews**, each with its own lifecycle, TTL, and decision. Consent evidence is channel-shaped; the questions the reviewer answers are genuinely different.
- Whether a coalesced event resets the request TTL is configurable; default **reset** (fresh consumer activity is exactly the evidence under review).

If one review is approved with cross-channel targets while a sibling review on the other channel is pending, the resulting derived writes **do not auto-resolve the sibling review**. It represents its own explicit consumer event and receives its own decision (even if trivially "keep local — already opted in"). One review's side effects never silently consume another's.

### 11.4 The review decision

Three outcomes, not two:

1. **Global** — propagate to all other systems (subject to precedence rule 1: explicit opt-outs are never overridden).
2. **Selective** — propagate to a chosen subset. Channel similarity is real signal; "does a text START cover the other SMS platform?" usually has a different answer than "does it cover email?"
3. **Keep local** — no propagation.

The UI presents target systems as a checklist **pre-populated from policy** (default-check same-channel systems, default-uncheck cross-channel — but cross-channel remains selectable when the underlying consent language genuinely covers it), with each target's opt-out history inline next to its checkbox (e.g., *"opted out via unsubscribe link, 2025-11-04"*).

### 11.5 Attestation, not a button

Approval does not create consent — consent exists in the evidence or it doesn't. The reviewer is shown the originating event(s), the consent evidence (actual language, method, timestamp), and per-system history, and must affirmatively confirm wording to the effect of:

> "I have reviewed the consent evidence and confirm it covers the selected systems and channels."

The attestation text, approver identity, decision note, and an evidence snapshot are stored immutably. This record is the § 227(c)(5) "reasonable practices and procedures" defense in concrete form.

### 11.6 Auto-cancel invariant (non-negotiable)

If **any** opt-out event arrives for the identity — on any system — while a review is pending, the request is **canceled automatically** with an audit record. No human in the loop. Opt-outs never wait on a queue.

### 11.7 Request object

```
approval_request {
  id
  identity_ref
  channel                   -- coalescing key component
  originating_event_refs[]  -- list; coalesced same-channel events
  evidence_refs[]
  proposed_targets[]        -- policy-derived default selection
  prior_state_snapshot[]    -- per-target state + provenance at render time
  version                   -- bumped on coalesce/snapshot refresh
  status                    -- pending | approved | denied | expired | canceled
  created_at, expires_at
  decided_by, decided_at
  attestation_text, decision_note
  resulting_event_refs[]    -- derived opt-in events written on approval
}
```

### 11.8 Concurrency, expiry, and fan-out

- **Optimistic concurrency:** the decision submission carries the `version` it was rendered from. If a coalesced event or snapshot refresh landed since, the stale decision is rejected back to the reviewer with updated context.
- **TTL:** pending requests expire (default 7–14 days, configurable) with an audit record. Consent evidence is time-sensitive; approving a months-old START against intervening history is the mistake the gate exists to prevent. Expired ≠ denied — re-initiation with fresh review is allowed.
- **Idempotent fan-out:** approval does not synchronously write to N platforms. It emits derived opt-in events into the log; expected state updates; the standard reconciler (§ 8) converges each target with retries. Double-clicks, retries, and partial failures all resolve correctly, and the UI shows per-target status: pending → written → confirmed (via echo).
- **Consumer experience guard:** a consumer who opts in and then hears nothing indefinitely will assume the system is broken. Reviews need timeouts and queue-notification routing, not just a manual backlog.

## 12. Manual management interface and RBAC

Employee-facing capabilities:

- View consolidated consent state and full event history for any identity.
- Manually record opt-outs (propagate immediately per policy) and opt-ins (subject to the same evidence and approval machinery as automatic events — manual entry is not a bypass).
- Work the approval queue (§ 11).
- Review reconciliation alerts (unwritable divergence, sync-lag breaches).
- **Configure sending services** (admin only) — register/connect a service, store its credentials, test the connection, discover and review its topology, and archive or delete it (§ 13.1).
- **Set deployment branding** (admin only) — an Appearance screen for an org name, logo, accent color, and page background (§ 13.2).

Admin-only capabilities (Services, Users, Appearance) are gathered under a single **Admin** menu that renders only for users with admin access, rather than advertising actions a user cannot reach. More broadly, the console shows each role only the menu items it can use.

Roles, minimally:

- **Viewer** — read-only.
- **Operator** — record manual events, initiate opt-in requests, run discovery/sync and topology annotation.
- **Approver** — decide approval requests.
- **Admin** — user management and service configuration (the Services screen, credentials, archive/delete).
- Configurable **initiator-cannot-approve** (separation of duties) for orgs under stricter regimes; small teams may disable.

Every manual action records the actor and lands in the same event log as automatic events.

## 13. Configuration surface

| Setting | Default | Notes |
|---|---|---|
| Opt-out propagation scope | all systems | per-system subsets configurable |
| Opt-in review trigger | explicit opt-out exists elsewhere | alternatives: any state elsewhere; none |
| Review TTL | 7–14 days | expiry ≠ denial |
| TTL reset on coalesce | reset | one-line config |
| Default proposed targets | same-channel checked, cross-channel unchecked | policy-driven |
| Initiator-cannot-approve | off | enable for separation of duties |
| Email canonicalization policy | conservative (variants distinct) | versioned |
| Sync-lag alert threshold | minutes-scale | regulatory ceiling 10 business days |
| Approver notification routing | — | email/webhook |
| Consent-check audit retention | suppress ≈ 4 yr / other ≈ 90 d | split by decision class (ADR-0004 §7) |
| Operational audit-log retention | 14 days | prunes `audit_log`; compliance actions (approval decisions, config changes, key mgmt) exempt |

### 13.1 Service configuration (admin)

Beyond the policy settings above, admins onboard and manage sending services from the **Services** screen — a two-phase flow (see ADR 0003):

1. **Register & connect.** Choose a platform type from the catalog (§9.1), name it, give it a permanent id, and enter credentials (stored write-only, encrypted at rest). Capability defaults pre-fill from the type and can be adjusted. **Test connection** runs a checklist — required credentials present, channel/discovery consistency, and a live adapter probe.
2. **Discover & review.** Pull the service's pools/groups/codes (reusing the topology sync of §10a), confirm them, and manually annotate where the service can't report a grouping. Discovered facts and manual annotations stay provenance-separate.

Lifecycle:

- **Archive (soft delete).** A service that has recorded consent is archived, not deleted: it drops out of the adapter registry (no more sends, discovery, or reconciliation) and is hidden from the operational views (consent matrix and the default services list) but keeps all consent history, so it still appears in every report. The Services screen has a *show archived* toggle (`GET /api/systems?includeArchived=1`); the default view is active-only. Reversible.
- **Delete (hard).** Permitted only when a service has **no** consent history (a never-used or misconfigured registration); it removes config/metadata children and the row in a transaction. The consent-history tables (`consent_events`, `consent_states`, `hub_writes`, `approval_targets`, `reconcile_alerts`) hold `RESTRICT` foreign keys to `systems`, so the database itself refuses to drop a service whose deletion would destroy consent records — the append-only log is protected at the schema level.

Migrations `005`–`007` add this surface: `adapter_type` and connection-lifecycle columns plus the write-only `system_credentials` table (005), the widened type set and OAuth `expires_at` (006), and the `archived_at` soft-delete marker (007). Nothing here is read by a consent decision (ADR 0002 §2.2).

### 13.2 Deployment branding

A deployment can make the console its own without recompiling. A single settings row (migrations `008` and `010`) holds an **org name**, a **browser-tab title**, a **logo** and a **favicon** (each an uploaded image `data:` URL or an `https://` URL), and a **color palette** — accent/links, page background, header bar, body text, cards, and the opt-in / opt-out / suppressed status colors, each a `#rrggbb` value driving a CSS variable. `GET /api/branding` is **public** (non-sensitive presentation data, and the sign-in screen — which renders before auth — brands itself from it); writes go through an admin via the Appearance screen / `PUT /api/branding`. Writes replace the whole set — an omitted or blank field clears that aspect back to the built-in default — and inputs are validated (hex colors, image/`https` logo ≤~512KB and favicon ≤~140KB, bounded text lengths). This is presentation only; like topology and service config, no branding value is ever read by a consent decision.

## 14. Audit and recordkeeping

- The event log is append-only; states are recomputable projections.
- Evidence and attestation records are immutable.
- Every approval decision (approve / deny / expire / auto-cancel) is itself an audited event with actor and timestamp.
- Hub-originated writes are distinguishable from consumer events end-to-end (`sync_origin_key`, `provenance`).
- Retention should meet or exceed the longest applicable statute of limitations for TCPA claims (typically 4 years federal; verify state analogs). The **consent-check** audit (`consent_checks`) keeps a split retention — suppress decisions ≈ 4 years (the § 227(c)(5) evidence), allow/error ≈ 90 days (ADR-0004 §7).
- The **operational** `audit_log` (routine activity: ingestion, reconcile runs, alerts, admin actions) is a secondary trail — the authoritative records are the append-only event log, evidence, and approval requests above, not this table. It is pruned on a short window (`auditLogRetainDays`, default 14 days) to bound its growth, **except** compliance-relevant actions — approval decisions and auto-cancels, configuration changes, and API-key create/revoke — which are retained indefinitely. Prune runs on the maintenance scheduler (`PRUNE_INTERVAL_HOURS`) and on-demand (`POST /api/audit-log/prune`, admin).

## 15. Open questions

1. **TTL reset on coalesce** — default chosen (reset) but flagged for revisit after operational experience.
2. **Identity linkage** (phone ↔ email for one person) — explicit-linkage-only in v1; whether to support assisted matching later, and what provenance/review it would require.
3. **Revoke-all rule finalization** — the FCC may modify 47 C.F.R. § 64.1200(a)(10) before its January 31, 2027 effective date; the configurable propagation scope is the hedge, but defaults should be revisited when the rule settles.
4. **Multi-tenant deployment** — current design assumes single-org self-hosted; multi-tenancy would touch identity scoping, RBAC, and the registry of adapters.
5. **Pending-review consumer messaging** — whether/how to send an automated acknowledgment on the originating channel while a propagation review is pending (must itself be TCPA-compliant; one confirmation message on the originating channel is generally permissible).
6. ~~**Inbound platform webhooks → ingest**~~ — **Resolved.** Signature-verified inbound is wired: the SendGrid Event Webhook, Twilio and Telesign STOP/START webhooks, Twilio Event Streams, the sender-report endpoint (`/api/v1/consent/report`), and poll-based ingestion (Constant Contact, AWS/Azure opt-out lists) all feed `ingest`, so consumer opt-outs originating on a live platform reconcile back and propagate. What remains is per-platform end-to-end validation against live credentials (tracked in PRODUCTION-READINESS.md), not implementation.
7. ~~**OAuth token refresh**~~ — **Resolved for the live OAuth client.** Refresh-on-401 with rotating-token persistence (`storeRotatedCredential`) is implemented and **verified working live for Constant Contact** (survived a real credential rotation). The pattern is ready to replicate for the other OAuth-based catalog types (HubSpot, Salesforce Marketing Cloud, Dynamics Journeys, Marketo) as each gains a live client.
8. **Non-secret connection params** — region, sending domain, API base URL, subdomain, etc. are currently held in the write-only credential store like secrets, so they aren't visible after save. Moving them onto the system row (editable in the clear) is a planned refinement.

---

*This document reflects design and implementation as of November 2026. Regulatory statements are summaries for engineering motivation, not legal advice.*
