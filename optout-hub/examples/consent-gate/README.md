# Shared consent gate for Class B senders

Reference integration code for the org's own senders (the custom Twilio texting
app, the email-to-SMS gateway) — **not** part of the hub runtime. The hub is
never in the send path (DESIGN §3); for a withhold-only platform, opt-out is
enforced *in the sender* by asking the hub before each send and **failing
closed** (ADR-0004). Copy these files into your sender. No dependencies beyond
`fetch` (Node 20+).

Used by both reference senders:
[`../twilio-sender/`](../twilio-sender/) and
[`../email-sms-gateway-sender/`](../email-sms-gateway-sender/).

## Files

### `consent-gate.ts`
- `mayContact(cfg, identities)` — batch-checks `POST /api/v1/consent/check` and
  returns a send/withhold decision per identity.
- `decide(result, identity)` — the pure fail-closed rule: only an explicit
  `allow` sends.
- `decideFallback(cache, identity, normalize)` — the pure OUTAGE rule: with a
  ready cache, degrade to the last-known suppression list; otherwise fail closed.
- On a 5xx / timeout / network error, `mayContact` uses the fallback when a
  `cache` is configured. On any **4xx** (bad key, wrong scope, rate limit) it
  fails closed — a misconfiguration must never be masked with stale data.

### `suppression-cache.ts`
- `SuppressionCache` — a last-known suppression set + sync cursor. `applyFeed()`
  folds a full baseline or an incremental delta; `isSuppressed()` is the lookup.
- `syncSuppressions(cfg, cache)` — pulls `GET /api/v1/consent/suppressions`
  (baseline, then deltas via the cursor). Call it on a schedule (30–60s).

## Wiring the cache

```ts
import { SuppressionCache, syncSuppressions } from '../consent-gate/suppression-cache.js';

const cache = new SuppressionCache();
const sync = { hubUrl: process.env.HUB_URL!, apiKey: process.env.HUB_API_KEY!, system: 'admissions_twilio' };
await syncSuppressions(sync, cache);                       // baseline once at startup
setInterval(() => syncSuppressions(sync, cache).catch(() => {/* keep last-known */}), 30_000);

// Then pass `cache` into the gate config used by mayContact():
const gate = { ...sync, channel: 'sms' as const, cache };
```

## Normalization parity

The cache stores the hub's `value_normalized`; the gate normalizes recipients
with `GateConfig.normalize` (default: E.164-ish phone, lower-cased email) before
cache lookups. In production, plug in the **same** normalization the hub uses
(e.g. libphonenumber) so cache hits are exact — a mismatch would let a
normalized-differently number slip past the cached list during an outage.
