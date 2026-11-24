# ADR 0004 — Real-time consent-check API for sending services

**Status:** Accepted
**Date:** July 2026
**Deciders:** Architecture/design session
**Related:** DESIGN.md §3 (reconciliation hub), §8.3 (unwritable divergence / withhold-only), §9 (adapter capabilities), §10 (opt-out propagation), §12 (RBAC); [ADR 0002](ADR-0002-service-discovered-topology.md) (SPOF rejection), [ADR 0003](ADR-0003-service-configuration-and-adapter-registry.md) (credential/auth posture)

---

## 1. Context / the gap

DESIGN.md states the hub's enforcement premise as *"the hub refuses to hand a suppressed identity's message to any adapter"* (§8.3, §10a). As built, this is **aspirational**: the hub is not in the send path. It synchronizes consent *state* — reading platform state (`observe`) and, where a platform keeps a caller-writable list, pushing opt-outs into it (`write`). The adapter contract (`contract.ts`) is outbound-only.

For **withhold-only** platforms — Telesign, Twilio, the higher-ed texting tools, email-to-SMS gateways (ADR 0003 §2.1) — there is no writable list to push into, and the hub sends nothing itself. So today a cross-platform opt-out propagated *to* one of these platforms has **no actual enforcement mechanism**: nothing stops that platform's own sender from messaging the suppressed identity. "Enforce by withholding sends" has no code behind it because the withholding party is the external sender, and the sender has no way to consult the hub.

This is the missing third leg of enforcement:

| Direction | Mechanism | Status |
|---|---|---|
| Hub **learns** of opt-outs from a platform | inbound webhook → ingest | roadmap (pending) |
| Hub **pushes** opt-outs into a platform's writable list | `adapter.write()` | partial (SendGrid) |
| Sender **asks** the hub before sending | **consent-check API** | **this ADR** |

Without the third leg, withhold-only platforms can only honor opt-outs that arrived directly on that platform — the cross-platform guarantee the hub exists to provide does not hold for them.

## 2. Decision

Add a **machine-facing, read-only consent-check API** that a sending service calls before sending, to ask a single question: *may this send go out to this identity on this system/channel?*

### 2.1 The question it answers — and the one it does not

The hub is a **suppression authority, not a consent-grant authority.**

- A **`suppress`** answer is authoritative and must be honored: the hub has a revocation (explicit or propagated) on record for that scope.
- An **`allow`** answer means only *"no revocation is on record"* — it is **necessary but not sufficient**. The sending service remains responsible for its own affirmative consent basis. The API must never be read as "the hub says you have consent," because a `state: unknown` identity (no record anywhere) also returns `allow`. Manufacturing the illusion of consent from "no opt-out on file" is exactly the failure the opt-in approval gate (DESIGN §11) exists to prevent, and the check API must not reintroduce it.

### 2.2 Shape

`POST /api/v1/consent/check` (versioned; POST, not GET, so the phone/email never lands in a URL or access log). Batchable — accepts one identity or an array, since senders check in bulk.

Request:
```
{ "system": "twilio-admissions", "channel": "sms",
  "identities": ["+12085550123", "person@example.edu"] }
```

Response (per identity):
```
{ "identity": "+12085550123",
  "normalized": "+12085550123",
  "decision": "suppress",              // suppress | allow
  "state": "suppressed",               // unknown | opted_in | opted_out | suppressed
  "scope": { "system": "twilio-admissions", "channel": "sms" },
  "reason": "opt-out propagated from constant_contact 2026-06-30",
  "as_of": "2026-06-30T14:02:11Z" }
```

- **Decision rule** (fail-safe toward suppression): `opted_out` or `suppressed` in scope → `suppress`; `opted_in` for that system/channel → `allow`; `unknown` → `allow` with a reason flagging that no record exists (see §2.1).
- **Scoping.** The answer is per **(identity, channel, system)**, computed from the same projection and precedence rules as everything else (DESIGN §6–§7). Opt-out/suppression propagates broadly per policy; opt-in is system/channel-scoped. Identity is normalized with `core/normalize.ts` (`normalizeIdentity`) so query-time matching is byte-identical to ingest-time matching; an un-normalizable identity is a `400`, never a silent `allow`.
- **Purely read-only.** A check never creates or mutates a consent event. A sender *reporting* an opt-out it received is a different capability (inbound → ingest), on a different endpoint, and out of scope here. *(That endpoint, `POST /api/v1/consent/report`, was subsequently built — see the Amendment at the end of this ADR.)*

### 2.3 Authentication — a new surface

Sending services are machines, so session/OIDC RBAC (DESIGN §12) does not fit. Introduce **service API keys**: issued per registered system (or per integration), hashed at rest (scrypt/AES posture of ADR 0003 §2.2 — no plaintext key stored), scoped so a key may only check identities within its system's remit, rate-limited, and revocable (disabling/rotating a key takes effect immediately, mirroring session revocation). Keys are admin-managed alongside service configuration.

### 2.4 Availability — reconciling with ADR 0002's SPOF rejection

ADR 0002 explicitly rejected a "hub all systems synchronously obey" model because it makes the hub a single point of catastrophic compliance failure. A naive pre-send query reintroduces exactly that dependency. Two decisions keep it safe **and** available:

1. **Callers fail closed.** If the hub is unreachable or errors, the integrating sender must treat the identity as *suppressed* (or queue the send), never send-through. Over-suppression carries no statutory penalty; under-suppression does (DESIGN §2.4). The safe degradation is silence.
2. **Query for freshness, cache for availability.** The check API is paired with, not a replacement for, the push/list-sync path (roadmap item: outbound writes). Where a platform keeps a writable list, the hub pushes opt-outs into it, so enforcement survives a hub outage on that platform natively. For withhold-only platforms, the recommended integration keeps a **locally-synced suppression cache** (delta-fed from the hub) and uses the live query for freshness — so a hub outage degrades to the last-known suppression list, not a hard stop on all messaging.

The hub thus remains a reconciliation hub and a *suppression* authority; it does not become the system of record for each platform's state, and no single synchronous call to it is the only thing standing between a consumer and a message.

## 3. Data model (additive)

- **`service_api_keys`** — `id`, `system_id`, `key_hash`, `label`, `scopes`, `created_by`, `created_at`, `last_used_at`, `revoked_at`. No plaintext.
- **Consent-check audit** — every check (identity, system, channel, decision, key, timestamp) is recorded for the "prove who did what" posture (DESIGN §14) and to give the sync-lag / liability reports real send-time data. Because this is high-volume and PII-bearing, it likely warrants its own table (not `audit_log`) with its own retention policy rather than unbounded growth.

No change to the consent event log, projection, precedence engine, or opt-out/opt-in semantics. The check is a read over the existing projection.

## 4. What this does not change

Consent semantics are untouched (the ADR 0002 §2.2 firewall holds — topology and config are still never read by a consent decision; the check *is* a consent read, which is its whole purpose). The hub does not begin sending messages. The check adds a read path and a machine-auth surface; it does not add a way to create consent.

## 5. Verification items (confirm before implementation)

> Progress on these is tracked in [ADR-0004-verification.md](ADR-0004-verification.md).

1. **Per-platform pre-send hook feasibility.** Can each target sending service actually make an outbound HTTP call in its send path (custom texting app: yes; campaign tools like Attentive/Klaviyo: often no custom pre-send hook)? For platforms that cannot, the **push-to-list / synced-cache** model is the *only* enforcement path, and the check API does not help them — this determines per-platform whether #3 is even viable and must be assessed adapter by adapter.
2. **Fail-open vs. fail-closed default**, and whether it is configurable per integration (default: fail-closed).
3. **Check-audit retention** — volume and PII retention window for logging every pre-send check.
4. **Rate limits and batch size** appropriate to real send volumes.
5. Whether `unknown → allow` is the right default for every deployment, and how the response wording keeps callers from treating `allow` as a consent grant (§2.1).

## 6. Consequences

**Positive:** gives withhold-only platforms a real enforcement mechanism, closing the last leg of the enforcement triangle; makes DESIGN's "withhold sends" claim true; the fail-closed + synced-cache design honors ADR 0002's anti-SPOF stance; reuses existing normalization, projection, and precedence unchanged.

**Negative / risks:** introduces a new machine-auth surface (API keys) to secure and audit; adds a hub availability dependency on the send path (mitigated by §2.4); only helps platforms that can run a pre-send hook (§5.1); high-volume PII logging needs a retention policy. The `allow`-is-not-consent nuance (§2.1) is easy for integrators to misread and must be documented at the API boundary, not just here.

## 7. Disclaimer

This ADR records design reasoning informed by general regulatory and vendor information; it is not legal advice. The §5 verification items — especially per-platform pre-send feasibility — must be confirmed before implementation.

---

## Amendment — September 2026: companion endpoints (report + suppressions)

The decision above defined `POST /api/v1/consent/check` and deliberately deferred two things: the *reporting* capability (§2.2, "a different endpoint... out of scope here") and the synced-cache feed, which §2.4 described only conceptually. Both were subsequently built. They are recorded here so the machine-facing API surface is documented in one place. Neither changes the decision, the fail-closed posture, or the consent semantics — both reuse the existing service-API-key auth (§2.3), scoping, rate limiting, normalization, and precedence engine.

The machine-facing API is therefore three endpoints, all per-system API-key authed and rate-limited: **`/check`** (ask before sending), **`/report`** (tell the hub about an event you received), **`/suppressions`** (sync a local blocklist).

### A.1 `POST /api/v1/consent/report` — sender-reported consent event

The write counterpart to the check, and the "different endpoint" §2.2 pointed at. When a sender's own app observes a consent change — e.g. a Twilio **STOP** arriving at a texting app's *existing* inbound webhook — it reports it here, so the hub does not have to own that platform webhook (which a third-party app may already own). This is an **inbound → ingest** capability, not a new consent primitive: the reported event is fed through the same `ingest()` path as a signed platform webhook, so normalization, opt-out propagation, precedence, replay/dedup, and audit are **identical**. Precedence still governs — a reported opt-in never overrides an explicit opt-out — so §2.1's "suppression authority, not consent-grant authority" framing is unchanged.

Request:
```
{ "system": "twilio-admissions", "value": "+12085550123",
  "direction": "opt_out", "occurred_at": "2026-08-31T14:02:11Z", "source": "twilio STOP" }
```
- `value` is normalized with `normalizeIdentity` (byte-identical matching to ingest); `direction` is `opt_out` | `opt_in`; `occurred_at` (ISO-8601) and `source` are optional. Returns `{ ok, normalized, direction }`.
- A key not scoped to `system` → `403`; an un-normalizable `value` or an invalid `direction` → `400` (never a silent success).

### A.2 `GET /api/v1/consent/suppressions` — delta-fed suppression feed

The concrete endpoint behind §2.4's "locally-synced suppression cache." It returns the suppressed identities for the key's system — a full baseline, plus `since`-parameter delta fetches — so an integrating sender can maintain a local blocklist and, per §2.4.1, **fail closed to the last-known list** during a hub outage rather than hard-stopping all messaging. Same service-API-key auth and system scoping.

This closes §5 items indirectly: `/report` gives withhold-only platforms whose webhook is owned elsewhere a way to feed the hub without repointing it, and `/suppressions` is the availability half of the "query for freshness, cache for availability" design (§2.4).
