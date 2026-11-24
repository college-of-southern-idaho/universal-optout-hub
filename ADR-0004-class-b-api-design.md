# ADR 0004 — Class B consent-check API: design

**Implements:** [ADR 0004](ADR-0004-consent-check-api.md), with the §5 decisions settled in [ADR-0004-verification.md](ADR-0004-verification.md).
**Scope:** the machine-facing consent-check API for **Class B** senders — platforms that are withhold-only *and* whose send path is our own code (the **custom Twilio texting app** and the **email-to-SMS gateway**). These call the hub before sending. Class A platforms are enforced by push (roadmap item 6); Class C await vendor conversations. This is the no-blocker build.
**Status:** Implemented (backend + admin UI). See §14 for as-built notes and what was deferred.

---

## 1. What it does

One question, asked before a send: **"May I send to this identity on this system/channel?"** The hub answers from the existing consent projection (`consent_states`) — the same state produced by ingest, propagation, and the reconciler backfill (DESIGN §8.5). No new consent logic; this is a read path plus a machine-auth surface.

Because propagation and backfill already ensure a suppressed identity has a `suppressed` state row on **every** active in-scope system, a check that reads `(identity, system, channel)` automatically reflects opt-outs that originated on other platforms. That is the whole point — and it falls out of machinery that already exists.

## 2. Endpoint

```
POST /api/v1/consent/check
```

POST (not GET) so phone/email never lands in a URL or access log. Versioned (`/api/v1`) so the contract can evolve. Batchable.

### Request
```jsonc
{
  "system": "twilio-admissions",     // a registered system id; must match the API key's scope
  "channel": "sms",                  // "sms" | "email"
  "identities": ["+12085550123", "person@example.edu"]   // 1..1000
}
```

### Response — `200 OK`
```jsonc
{
  "results": [
    {
      "identity": "+12085550123",
      "normalized": "+12085550123",
      "decision": "suppress",                 // "suppress" | "allow"
      "state": "suppressed",                  // unknown | opted_in | opted_out | suppressed
      "scope": { "system": "twilio-admissions", "channel": "sms" },
      "reason": "opt-out propagated from constant_contact 2026-06-30",
      "as_of": "2026-06-30T14:02:11Z",
      "advisory": null
    },
    {
      "identity": "person@example.edu",
      "normalized": "person@example.edu",
      "decision": "allow",
      "state": "unknown",
      "scope": { "system": "twilio-admissions", "channel": "sms" },
      "reason": "no suppression on record",
      "as_of": null,
      "advisory": "Not a consent grant; the sender remains responsible for its own lawful basis to contact."
    }
  ]
}
```

Note the **structured result, never a bare boolean** (verification item 5). `advisory` is populated whenever `decision = allow` and `state != opted_in`, so `allow` can't be misread as "the hub cleared this send."

## 3. Decision logic

For each identity: normalize → look up the `consent_states` row for `(identity, system, channel)` → map state to a decision.

| Projected `state` | `decision` (default = **blocklist**) | `decision` (allowlist mode) |
|---|---|---|
| `opted_out` | `suppress` | `suppress` |
| `suppressed` | `suppress` | `suppress` |
| `opted_in` | `allow` | `allow` |
| `unknown` / no row | `allow` (+ advisory) | `suppress` (+ advisory) |

- **Blocklist** (default): send unless a revocation is on record. `unknown → allow`.
- **Allowlist** (opt-in per deployment, one config flag): send only with a positive local opt-in. `unknown → suppress`. Documented as deliberately stricter because it blocks first-contact/transactional sends.
- Scope and precedence are exactly DESIGN §6–§7; this endpoint computes nothing new, it reads the projection.

## 4. Identity normalization

Reuse `core/normalize.ts` `normalizeIdentity` so query-time matching is byte-identical to ingest. An identity that fails to normalize is reported per-item as an error, never a silent `allow`:
```jsonc
{ "identity": "not-a-number", "normalized": null,
  "decision": "error", "state": null, "reason": "unrecognized identity format" }
```
A malformed identity does not fail the whole batch; other items still return.

## 5. Authentication — service API keys

Machine callers, so not the session/OIDC path (DESIGN §12). New surface:

- **Header:** `Authorization: Bearer <key>` (or `X-API-Key: <key>`).
- **Storage:** only a hash is stored (`sha256`; keys are high-entropy random, so a fast hash is fine — unlike user passwords, no scrypt needed). Reuse the crypto posture of `core/secrets.ts` / ADR 0003 §2.2. The plaintext key is shown **once** at creation and never again.
- **Scope:** each key is bound to one `system_id`; a check whose `system` ≠ the key's system is `403`. (A future org-wide key with an explicit scope list is possible but out of scope here.)
- **Revocation:** setting `revoked_at` takes effect immediately (checked every request), mirroring session revocation.
- **Admin-managed:** issued/revoked from the Services admin screen, alongside the service's credentials.

## 6. Fail-closed contract (verification item 2)

Enforcement lives on the **caller** side, but the contract is specified here so integrators build it right:

- On `5xx`, timeout, or network error, the caller **must** treat the identity as **suppressed** (or hold/queue the send) — never send-through.
- The recommended client keeps a **hub-synced local suppression cache** and, on hub-unreachable, falls back to that last-known list (fail-to-cache) — still a suppression check, not a blind allow.
- **Blind fail-open is not a supported mode.** This will be stated at the API boundary (docs + the integration guide), not just in the ADR.
- Server target: the check is a single indexed lookup; keep p99 low so callers can set a tight timeout and fail closed on breach.

## 7. Audit (verification item 3)

Every check is recorded to a **dedicated table** (`consent_checks`), separate from `audit_log`, so its volume and retention are governed independently:

- **`suppress` decisions** (a send was withheld) — retained ~4 yr (statute), high-value evidence for the § 227(c)(5) affirmative defense.
- **`allow` decisions** — retained 30–90 days or rolled up to aggregate counts (exact window pending counsel).
- A prune enforces the split. **Built** — `services/retention.ts` (`pruneConsentChecks`): two indexed DELETEs in one transaction (`suppress` past `CONSENT_CHECK_RETAIN_SUPPRESS_DAYS`, default 1461 ≈ 4 yr; `allow`/`error` past `CONSENT_CHECK_RETAIN_OTHER_DAYS`, default 90), audited with per-class counts. On-demand via `POST /api/consent-checks/prune` (admin) and an admin card in the Audit-log tab, mirroring the reconciler; production schedules it (cron / job runner). Sync-lag / liability reports (existing `/api/reports/*`) can join `consent_checks` for real send-time coverage data.

## 8. Rate limits & batch (verification item 4)

- **Batch size:** 1..1000 identities per request; over 1000 → `400`.
- **Per-key rate limit:** default 60 req/s burst (`CONSENT_CHECK_RATE_LIMIT_PER_SEC`), configurable per key via `service_api_keys.rate_limit_per_sec` (a value of `0` disables the limit for that key); exceeded → `429` with `Retry-After`. **Built** — a token bucket per key (capacity == rate), enforced by `requireRateLimit` after key auth. See §14.
- **Integrator guidance:** batch-check a campaign's recipient list up front; do not make a synchronous per-message call at fan-out.

## 9. Status codes

| Code | Meaning | Caller action |
|---|---|---|
| `200` | Results returned (per-item may include `decision: "error"`) | Honor each `suppress`/`allow` |
| `400` | Malformed request (bad channel, batch > 1000) | Fix request |
| `401` | Missing/invalid API key | — |
| `403` | Key not scoped to the requested `system` | — |
| `429` | Rate limited | Back off per `Retry-After` |
| `503` | Hub unavailable | **Fail closed** (suppress / queue) |

## 10. Data model (migration `009`)

```sql
-- 009_consent_check_api.sql  (sketch)
CREATE TABLE IF NOT EXISTS service_api_keys (
  id           SERIAL PRIMARY KEY,
  system_id    TEXT NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  label        TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,           -- sha256 of the presented key
  scopes       TEXT[] NOT NULL DEFAULT '{}',   -- reserved; system_id is the scope today
  created_by   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS consent_checks (
  id           BIGSERIAL PRIMARY KEY,
  checked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  api_key_id   INT REFERENCES service_api_keys(id) ON DELETE SET NULL,
  system_id    TEXT NOT NULL,
  channel      TEXT NOT NULL CHECK (channel IN ('sms','email')),
  identity_norm TEXT NOT NULL,
  decision     TEXT NOT NULL CHECK (decision IN ('suppress','allow','error')),
  state        TEXT
);
CREATE INDEX IF NOT EXISTS consent_checks_prune ON consent_checks (decision, checked_at);
```

`ON DELETE CASCADE` on `service_api_keys.system_id` is safe (keys are config, not consent history). `consent_checks.system_id` is intentionally **not** a FK, so pruning/archiving a system never blocks on check logs, and check history survives a system's hard-delete for reporting. (Consent-history tables keep their `RESTRICT` FKs per ADR 0003 §2.4 — unchanged.)

## 11. Where it plugs into the code

- **Route:** new `POST /api/v1/consent/check` in `src/api/server.ts`, behind a new `requireApiKey` middleware (parallel to `requireRole`).
- **Auth:** `src/auth/apikeys.ts` — issue/verify/revoke, hash helpers.
- **Logic:** `src/services/consent-check.ts` — normalize, read projection, map decision; reuses `core/normalize.ts` and the `consent_states` read.
- **Admin UI:** an API-keys panel on the Services screen (`web/index.html`) + `POST/GET/DELETE /api/systems/:id/api-keys`.
- **Migration:** `db/migrations/009_consent_check_api.sql`.
- **Tests:** decision-table unit tests (pure `mapDecision(state, mode)`), normalization-parity tests, auth/scope/revocation tests, batch-limit and malformed-identity tests.

## 12. Out of scope (explicitly)

- **Reporting an opt-out via API** (sender → hub, inbound) — that is ingest (roadmap item 7), a separate endpoint.
- **Class A push** and **Class C** enforcement.
- **Creating or mutating consent** — this endpoint is read-only.
- Org-wide (multi-system) API keys — single-system scope only for now.

## 13. Open questions for implementation — resolved

1. `Authorization: Bearer` vs `X-API-Key` — **both accepted** (`extractApiKey` in `auth/apikeys.ts`); Bearer is the documented default.
2. Rate-limit store — **in-process token bucket** (`auth/ratelimit.ts`), keyed by `service_api_keys.id`. Single-process by design (PoC); a multi-instance deployment swaps the registry for a shared store (e.g. Redis) behind the same `rateLimitCheck` signature. Both the batch cap (1..1000) and the per-key rate limit are enforced.
3. `consent_checks` write — implemented as a **synchronous best-effort** insert (one multi-row statement wrapped in try/catch so an audit-write error never fails a decision). A fully async/fire-and-forget path is a future refinement.

## 14. As built (implemented in PRs #11 backend, #12 admin UI)

**Shipped as designed:** `POST /api/v1/consent/check` (batched, POST-only, structured results with advisory); the `mapDecision` table with blocklist default + `CONSENT_CHECK_MODE=allowlist`; identity normalization parity; per-system service keys (sha256, shown once, instant revocation) with `requireApiKey`; admin issue/revoke routes and the Services-editor key panel; migration `009` (`service_api_keys`, `consent_checks`); the fail-closed contract documented at the boundary. **Per-key rate limiting** (§8): a per-key token bucket (`auth/ratelimit.ts`, migration `011`), hub-wide default `CONSENT_CHECK_RATE_LIMIT_PER_SEC=60`, per-key override in the admin key panel, `429` + `Retry-After` on breach; pure-unit tested (`test/ratelimit.test.ts`). **Audit-retention prune** (§7): split-retention prune of `consent_checks` (`services/retention.ts`, `POST /api/consent-checks/prune`, admin Audit-log card), pure-unit tested (`test/retention.test.ts`).

**Reference sender integrations (built):** both Class B senders now have reference integrations sharing one fail-closed gate (`examples/consent-gate/`): the **custom Twilio sender** (`examples/twilio-sender/`) and the **email-to-SMS gateway sender** (`examples/email-sms-gateway-sender/`, SMTP transport, SMS consent classification, pluggable mail client). The gate now includes the **fail-to-cache availability path** (§2.4): a `SuppressionCache` fed by `syncSuppressions()` from the new `GET /api/v1/consent/suppressions` feed (baseline + `since` deltas, same key auth / scope / rate limit as the check endpoint), so a hub **outage** degrades to the last-known suppression list; a 4xx still fails closed. Pure-unit tested (`test/consent-gate.test.ts`, `test/suppression-cache.test.ts`, `test/suppression-feed.test.ts`, `test/email-sms-gateway.test.ts`). These remain illustrative code for the org's external apps to adopt, not wired production senders.

**Deferred (designed here, not yet built):**
- **Wiring the reference gate into the real production senders** — the examples above are copy-in references; adopting them in the actual sending apps (with the hub's exact identity normalization) is the remaining step.

**Not unit-tested at the DB layer:** consistent with the repo's pure-unit approach, `mapDecision` and key hashing are covered; the DB-backed `checkConsent` path and the routes are exercised by `tsc` + manual/live testing, not integration tests.
