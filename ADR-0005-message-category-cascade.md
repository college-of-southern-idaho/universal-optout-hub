# ADR 0005 — Message-category opt-out cascade

**Status:** Accepted
**Date:** September 2026
**Deciders:** Architecture/design session (CSI)
**Related:** DESIGN.md §10 (opt-out propagation), §9 (adapter capabilities), §2 (regulatory context), §11.3 (channel-scoped review); [ADR 0002](ADR-0002-service-discovered-topology.md) (topology firewall), [ADR 0004](ADR-0004-consent-check-api.md) (consent-check API); the federal-regulation research briefing (`optout-hub/docs/federal-optout-consent-research.md`)

---

## 1. Context / the gap

Opt-out propagation (DESIGN §10) originally used a single scope knob: `optOutPropagation` = `all` or a comma-separated list of system ids. Every opt-out fanned out to all (or a fixed subset of) systems, **regardless of message type**. That over-suppresses: a consumer who replies **STOP** to a *marketing* text is then silenced on *transactional* and even *emergency* channels too.

The federal-regulation research sharpened the problem. Federal law does **not currently require** the broad cascade — the FCC "revoke-all" scope (47 C.F.R. § 64.1200(a)(10)) is delayed to **Jan 31, 2027** and may be narrowed or eliminated first. Meanwhile the law **does** protect emergency messaging (the TCPA emergency-purposes exception, 47 C.F.R. § 64.1200(f)(4)) and **does** distinguish message categories (telemarketing vs. informational/transactional under the TCPA; "commercial" vs. "transactional or relationship" under CAN-SPAM). A flat all/subset knob can express none of this — it can neither scope suppression by category nor guarantee that emergency messaging survives an opt-out.

## 2. Decision

Replace the scope knob with a **data-driven, per-service message-category model** and a **category → category cascade matrix**.

### 2.1 Category as a per-service classification

Each system carries a `category` — a *consent-relevant* attribute alongside `channel`, and deliberately distinct from the operational/topology fields the ADR-0002 firewall keeps out of consent decisions. Categories are **data-driven** (a `consent_categories` registry), admin-editable, seeded with **marketing / transactional / emergency**. It is a property of the **service**, not the message, because a single-purpose sender — e.g. one Twilio Messaging Service per purpose — maps to one category cleanly. (Message-level categorization was considered and deferred; see §5.)

### 2.2 The cascade matrix

An opt-out on a source-category service suppresses target-category services **iff** the admin-configured `consent_category_cascade` matrix enables (source → target). The seeded default is same-category + `transactional → marketing`. This matrix is the operational lever a deployment tunes to the law's final shape without a code change.

### 2.3 Protected categories — emergency is never suppressed

A category flagged `protected` is **never a cascade target** — enforced in the engine (`deriveSuppression` skips it) regardless of the matrix, so emergency/safety notices are always deliverable (47 C.F.R. § 64.1200(f)(4)). Generalizing "emergency" to a *flag* (rather than a hard-coded string) means a future FCC-exempted class of message is a config change, not a code change.

### 2.4 Channel-scoped

Propagation cascades only **within the channel the opt-out originated on** (phone → SMS, email → email). A phone opt-out and an email opt-out are distinct identifiers and distinct consents; they never cross. The email-to-SMS gateway is SMS by classification and stays within SMS.

### 2.5 Lifecycle

Categories can be **archived** (retired from new assignment, still honored for services already on them) or **deleted** (only when no service uses them — otherwise archive), mirroring the services archive/delete model.

## 3. Data model (additive)

- **`consent_categories`** — `key`, `label`, `protected`, `sort_order`, `archived_at`.
- **`systems.category`** — FK to `consent_categories(key)`, `NOT NULL DEFAULT 'marketing'`.
- **`consent_category_cascade`** — `(source, target)`; presence of a row = that cascade is enabled. Rows drop via `ON DELETE CASCADE` when a category is deleted.

Migrations 016–017. **No change** to the consent event log, projection, or precedence engine: the cascade only decides *which* systems a derived suppression lands on; the suppression itself is an ordinary `derived` opt-out event folded by the same rules as before.

## 4. What this does not change

- **Consent semantics.** A derived suppression is still a derived opt-out event; precedence is unchanged (a derived event never overrides an explicit one; opt-out still wins at equal provenance).
- **The adapter contract.** Enforcement still dispatches through `can_write_optout` + `adapter.write()`, so the cascade is **platform-agnostic** — a new platform participates by being tagged with a category, with no change to the cascade code.
- **The topology firewall (ADR-0002).** `category` is a consent classification like `channel`, not discovered topology; topology is still never read by a consent decision.

## 5. Verification items / open questions

1. **Per-message vs. per-service granularity.** Per-service assumes single-purpose senders. If a platform genuinely mixes marketing and transactional on one sender (e.g. SendGrid unsubscribe groups, HubSpot subscription types), revisit: message-level would need a `category` parameter on the consent-check/report API and per-category consent state.
2. **Legal boundaries.** The category definitions and the default matrix encode the federal research and must be confirmed with counsel against the revoke-all rule's final form and Idaho state law — especially whether a bare STOP legally sweeps across categories once § 64.1200(a)(10) is in force.
3. **Cross-channel intent.** Channel-scoping treats phone and email as separate consents; confirm this matches how CSI wants cross-channel revocation handled (the revoke-all trajectory is cross-*subject*, not cross-*channel*).
4. **Write-side confirmation per platform.** A cascade to a write-only-no-read platform (Twilio Consent API) can never be confirmed and shows as an "unconfirmed write"; an unwritable platform (Telesign/SNS) raises an alert. Expected, but the operator view must not read these as faults.

## 6. Consequences

**Positive:** eliminates cross-category over-suppression; guarantees emergency deliverability; is operationally tunable to the law's evolving shape without a redeploy; is data-driven and extensible; stays platform-agnostic by riding the adapter contract; and grounds propagation in the federal research rather than a blanket policy.

**Negative / risks:** per-service category assumes single-purpose senders (mixed senders must be split into multiple hub systems or accept coarse tagging); the matrix is another admin surface to configure correctly; the migration defaults every existing service to `marketing` so behavior is *preserved, not auto-tightened* until an admin reclassifies; and the category boundaries and default matrix need counsel sign-off before they can be relied on for compliance.

## 7. Disclaimer

This ADR records design reasoning informed by the federal research and general regulatory information; it is **not legal advice**. That research itself flags the CAN-SPAM email specifics and Idaho state-law items as unverified, and the revoke-all effective date has moved repeatedly. Confirm the category boundaries, the default matrix, and the effective dates with qualified counsel before relying on them.
