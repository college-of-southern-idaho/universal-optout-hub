# ADR 0002 — Service-discovered topology (reporting-only)

**Status:** Accepted
**Date:** June 2026
**Deciders:** Architecture/rule design session
**Supersedes:** [ADR 0001](0001-group-scoped-optin-pooling.md)
**Related:** DESIGN.md §3 (reconciliation hub), §9 (adapter contract), §10/§10a; M0 compliance invariants

---

## 1. Context / what changed

ADR 0001 proposed grouping sending codes and auto-propagating an opt-in across a group's code pool. That rested on the hub being able to **write** consent outward to sibling codes. Investigation of the sending services showed the premise fails:

- **Telesign** keeps no caller-writable suppression or consent list. It detects STOP/START keywords and **notifies the integrator via callback**; the integrator maintains the list. There is no "register this opt-out for this number/pool" endpoint to call.
- Other services differ (Twilio maintains its own opt-out state and exposes management; Constant Contact manages list subscriptions), so write-back is **per-adapter**, never assumable.

Two corrections follow:

1. **The hub is confirmed as a reconciliation hub, not a system of record.** Each service stays authoritative for its own events. The hub's authority is over a single question — *may this send go out?* — enforced at send time by withholding messages for suppressed identities. (A "hub as ultimate source of truth that all systems obey" model was explicitly rejected: it creates a single point of catastrophic compliance failure if the hub is unavailable. See DESIGN.md §3.)
2. **Group-pooled automatic opt-in propagation is removed** (ADR 0001). It had no mechanism to land writes and coupled topology to consent behavior.

This ADR keeps the *useful* part of ADR 0001 — knowing which codes belong to which department — but redefines how that knowledge is obtained and what it may be used for.

## 2. Decision

1. **Topology is discovered from the sending services, not configured in the hub.** An operator registers a *system* (a service integration); the hub then discovers that system's pools/groups/codes from the service and keeps them current by periodic sync. Configuration changes at the service (a new long code added to "Admissions") propagate into the hub automatically; they are not re-entered by hand.

2. **Topology is reporting/attribution metadata only.** It labels which department/pool an event or code belongs to, for reporting and operational visibility. **Consent decisions never read from topology.** It is not a consent-scope authority and never triggers propagation. This firewall is absolute; making topology behavior-affecting would be a separate, deliberate future decision with its own review.

3. **Discovery is a per-adapter capability.** The adapter contract declares whether a system can discover topology and at what granularity. Where a service cannot report groupings, codes are recorded as ungrouped (`source: none`) rather than the hub inventing structure.

4. **Optional manual annotation layer, with provenance.** For services that cannot report groupings (e.g., department pools that live only in a team's records), an operator may annotate codes with a grouping label. Annotations are stored with `source: manual`, kept **separate** from discovered facts (`source: <service>`). When discovery and annotation disagree, the hub **shows both** rather than letting either silently overwrite the other — the same explicit/derived provenance discipline used for consent. Auto-discovery never silently destroys a human annotation, and a manual annotation never masquerades as a discovered fact.

## 3. Opt-out behavior is unchanged and unaffected

Global opt-out by suppression works regardless of whether a service accepts writes, because suppression is enforced at **send time** on the hub's side: the hub refuses to hand a suppressed identity's message to any adapter. Telesign's lack of a writable list does not weaken opt-out — it just means Telesign's opt-out enforcement is "withhold sends" rather than "write a flag." This was always an anticipated adapter shape (`can_write_optout = false` → enforce by withholding; see DESIGN.md §9).

## 4. Data model

- **System:** a registered service integration (unchanged concept).
- **Topology node:** `system_id`, `kind` (pool | group | code), `external_ref` (the service's own id), `parent_ref`, `source` (`<service>` | `manual` | `none`), `last_seen_at`.
- **Code:** gains discovered `group/pool` association via topology nodes rather than a hand-set `group_id`.
- **Annotation:** `code_ref`, `label`, `source = manual`, `actor`, `created_at` — distinct from discovered nodes.
- **Event attribution:** an inbound event records the receiving code; reporting joins through topology to the pool/department. (Requires the inbound callback to carry the receiving code — see §6.)

No change to the consent event log, projection, precedence engine, or the opt-out/opt-in semantics.

## 5. Topology sync

A lightweight periodic reconciler per discovery-capable adapter: pull the service's current pools/codes, diff against last-seen, upsert nodes, and mark absent nodes decommissioned (soft). Ordering/staleness discipline mirrors the consent reconciler so a late or partial poll does not clobber newer truth. Manual annotations are never touched by this loop.

## 6. Verification items (confirm before implementation)

1. **Telesign inbound callback payload (Telesign account team):** confirm the STOP/START callback includes the **receiving long code / sender ID**, which event attribution and reporting depend on. *(Carried over from the Telesign adapter investigation.)*
2. **Per-service discovery capability (each adapter):** confirm what topology each service exposes via API and at what granularity (Twilio Messaging Services/sender pools; Telesign provisioned numbers and whether groupings are machine-readable; Constant Contact lists).
3. **Annotation governance:** who may add/edit manual grouping annotations, and confirm annotations are audited.

## 7. Consequences

**Positive:** removes the fragile write-dependent opt-in pooling; keeps grouping as useful reporting; eliminates hand-mirroring of service configuration; preserves the reconciliation-hub resilience; reuses the provenance pattern the team already knows.

**Negative / risks:** topology accuracy now depends on discovery freshness (mitigated by periodic sync and `last_seen_at` visibility); services with no machine-readable grouping rely on manual annotation, which can drift (mitigated by provenance separation and showing discovery-vs-annotation conflicts rather than silently resolving them).

## 8. Disclaimer

This ADR records design reasoning informed by general regulatory and vendor information; it is not legal advice. The §6 verification items must be confirmed with the vendors/account teams before implementation.
