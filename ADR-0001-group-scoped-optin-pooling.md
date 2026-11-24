# ADR 0001 — Group-scoped opt-in pooling across sending codes

**Status:** Superseded by [ADR 0002](0002-service-discovered-topology.md) (June 2026)
**Date:** June 2026
**Deciders:** Architecture/rule design session
**Related:** DESIGN.md §6–§11; M0 compliance invariants; FCC revoke-all rule (47 C.F.R. § 64.1200(a)(10))

> **Superseded.** This decision assumed the hub could write opt-in state outward to a group's sibling sending codes, so an opt-in on one code would auto-propagate across the group's pool. Investigation of the sending services showed the premise does not hold uniformly — notably, Telesign maintains no caller-writable suppression/consent list: it notifies the integrator of STOP via callback and the integrator holds the list. With no reliable mechanism to land propagated opt-ins on sibling codes, automatic group-pooled opt-in propagation has no foundation. ADR 0002 replaces it with **service-discovered topology**: groups/pools/codes are discovered from each sending service and used as **reporting/attribution metadata only** — never a consent-scope authority or propagation trigger. The reasoning below is retained for the decision trail.

---

## 1. Context

The texting platforms operate multiple long and short codes. Codes are assigned to departments/groups (e.g., *Admissions*, *Enrollment Services*), and a single group may hold several codes. The design session resolved to keep the existing global opt-out architecture and to refine opt-in behavior so that an opt-in arriving on one code applies across that code's whole group pool.

This ADR records that decision, the legal reasoning that constrains it, and the conditions under which it is safe.

## 2. Decision

1. **Opt-out remains global and unchanged.** An opt-out received on any number/code suppresses the identity across **every** number in the system, regardless of group. This is the most defensible posture and aligns with the FCC revoke-all trajectory. No change.

2. **Opt-in propagates within a group's code pool — conditionally.** An opt-in received on a code propagates automatically to the other codes in the same group **only when the group is a single consent scope** (see §3). Propagation beyond the group — to other groups or other systems — continues to require the human-attestation gate from DESIGN.md §11.

3. **The group boundary is the line between automatic and gated opt-in propagation.**
   - Within a group declared as one consent scope → automatic, no review.
   - Across groups or across systems → human-attestation gate applies.

## 3. The governing principle

Consent attaches to **what the consumer agreed to receive**, not to a piece of telecom infrastructure. Propagating an opt-in to other codes is lawful only to the extent the consumer's consent already reaches them.

A group therefore pools opt-ins only if it represents **one consent relationship** — multiple codes serving as delivery capacity for a single program (e.g., all *Admissions* codes carry "CSI Admissions texting"). If instead the codes represent **distinct programs/purposes**, auto-propagation manufactures consent the consumer never gave, and those opt-ins must fall back to the gate.

## 4. Preconditions for within-group auto-propagation

Within-group automatic opt-in propagation is a deliberate, narrow exception to the M0 invariant requiring human attestation on propagated opt-ins. It is only sound when **both** hold:

1. **Explicit consent-scope assertion.** The group carries an admin-set flag (`consent_scope = single_program`) declaring it is one consent relationship. This is never the default; a group that cannot truthfully assert it does not get auto-propagation, and its opt-ins route to the gate.

2. **Program-scoped consent evidence.** The consent language captured at opt-in references the **program**, not the number. "I agree to receive texts from CSI Admissions" supports pooling across Admissions codes; "I agree to receive texts at 208-555-0100" does not. The opt-in evidence record must capture the program-scoped language, because that stored evidence is what demonstrates the propagation stayed within consent.

If either precondition fails, the opt-in is honored on its originating code and the rest of the group is left to the human-attestation gate.

## 5. Invariants that still bind (unchanged)

- **Global opt-out wins.** A STOP on any single code suppresses the whole system; a later START re-consents only within its group's scope.
- **Derived never overrides explicit.** A propagated (group-pooled) opt-in can never override an explicit opt-out on a specific code.
- **Carrier layer is read-mostly for opt-in.** START on one code tells the carrier nothing about sibling codes. When the hub sets a group pool to expected opted-in, any code where the carrier still shows a standing STOP is **unwritable divergence**: surfaced as an alert, routed around, never forced. The hub holds the intended group-wide opt-in; individual codes converge only as the carrier permits.
- **Additive-only.** Group scoping may let a consumer receive less; it may never be used to justify sending more.

## 6. Data model additions

- **Code/number:** gains `group_id` membership.
- **Group:** gains `consent_scope` (`single_program` | `distinct_programs`), a `program_id`/program label, and its code pool.
- **Opt-in evidence:** references the `program_id` and stores the program-scoped consent language.

No change to the event log, projection, precedence engine, or opt-out path. The reconciler treats a group-pool opt-in as N expected-state updates (one per code), each converging independently under the existing rules.

## 7. Verification items (confirm before implementation)

These are factual/legal, not architectural — and they are where the exposure sits:

1. **Consent-relationship mapping (counsel).** Confirm each group maps to one genuine consent relationship, not a bundle of distinct programs.
2. **Sign-up language audit (counsel + departments).** Confirm Admissions and Enrollment Services' actual opt-in flows capture program-scoped consent language.
3. **Carrier/aggregator portability (Twilio + Telesign).** Each code is typically its own registered A2P campaign under CTIA/10DLC rules. Confirm the aggregators permit treating consent as portable across separately-registered codes in a pool. The legal consent-scope argument and the carrier campaign-registration rules are separate layers; both must agree before pooling.

## 8. Consequences

**Positive:** matches operational reality (departments with multiple codes); preserves the strong global opt-out; keeps the human gate exactly where consent scope is uncertain; the change is additive to the existing model.

**Negative / risks:** introduces a configurable exception to the attestation invariant, so the `consent_scope` flag becomes a compliance-sensitive setting that must be governed (who can set it, and on what basis). A mis-declared group is a latent compliance defect — a group flagged `single_program` that is really several programs would auto-propagate consent unlawfully. Mitigations: the flag is admin-only and audited; setting it should reference the documented consent-relationship determination from §7.1.

## 9. Disclaimer

This ADR records design reasoning informed by general regulatory information; it is not legal advice. The §7 verification items must be confirmed with counsel and the aggregators before this decision is implemented.
