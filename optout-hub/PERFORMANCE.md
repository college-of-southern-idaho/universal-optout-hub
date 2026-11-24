# Performance & load testing

This app ships a small, dependency-free load-testing kit under [`loadtest/`](./loadtest)
so you (and anyone adopting the project) can size a deployment, find its ceiling,
and catch regressions. It targets the paths that actually take production pressure:
the per-send **consent-check** API, inbound **opt-out reports** (write + cascade),
and the **suppression feed**.

Everything runs on plain Node (`tsx`) — no k6/Go/JMeter to install — so
`npm run loadtest:seed && npm run loadtest` works on any box that already runs
the hub.

---

## TL;DR

```bash
# 1. On a machine with DB access, seed a THROWAWAY database (name must end in _test):
DATABASE_URL=postgres://user:pass@db-host:5432/optout_hub_test \
  npm run loadtest:seed -- --systems 6 --identities 200000 --base http://your-hub.example.edu:3000

# 2. Restart the hub so it picks up the seeded systems (needed for report/mixed runs).

# 3. From a SEPARATE machine (not the hub), ramp until it bends:
npm run loadtest -- --mode check --ramp 25,50,100,200,400 --stage-seconds 20 --p99-slo 150

# 4. When done, wipe the synthetic data:
DATABASE_URL=…/optout_hub_test npm run loadtest:clean
```

> **Run the generator on a different machine from the hub.** A load generator is
> CPU-hungry; co-locating it with the app and Postgres just measures the test box.
> In local WSL smoke tests, throughput flat-lined at ~90–100 req/s *regardless of
> pool size* purely because the generator, app, and Postgres were fighting over
> the same cores. Those are not real numbers — a dedicated generator → your-hub.example.edu
> is what produces a reference figure.

---

## The pieces

| File | What it does |
|---|---|
| `loadtest/dataset.ts` | Deterministic identity/system generators shared by seeder + generator, so they agree without exchanging data. Synthetic ranges (`+1555…`, `…@loadtest.invalid`, `lt_sys_*`) are valid to the normalizer, patternable for cleanup, and can't collide with real traffic. |
| `loadtest/seed.ts` | Fills a throwaway DB: N mock systems, one **unlimited** API key each, a large identity table, and a realistic mix of consent states. Writes `loadtest/keys.json`. `--clean` wipes it. |
| `loadtest/run.ts` | Closed-loop generator. `check` / `report` / `mixed` modes, constant or staged-ramp load, reports RPS + p50/p95/p99 + error/429 rates, optional p99 SLO verdict, JSON output. |

### Safety rails
- **Seeder refuses any database whose name doesn't end in `_test`** (override
  `HUB_ALLOW_NONTEST_DB=1`). It inserts millions of junk rows — never point it at
  your live hub DB. Use a dedicated `*_test` database or instance.
- **The load-test API keys have `rate_limit_per_sec = 0`** (limiter disabled for
  that key). This is deliberate: you want to measure the app, not the throttle.
  `keys.json` therefore contains live key plaintext and is git-ignored.

---

## Seeder options

`npm run loadtest:seed -- [flags]`

| Flag | Default | Meaning |
|---|---|---|
| `--systems N` | 6 | Mock systems, alternating sms/email. |
| `--identities N` | 200000 | Identities **per channel** (table holds `2N` rows). |
| `--opt-out-ratio` | 0.20 | Fraction of (identity, system) pairs seeded as an explicit opt-out. |
| `--suppressed-ratio` | 0.05 | Fraction seeded as a derived suppression. |
| `--opt-in-ratio` | 0.15 | Fraction seeded as an explicit opt-in (rest are unknown / no row). |
| `--base URL` | `http://localhost:3000` | Base URL written into `keys.json`. |
| `--clean` | — | Delete all synthetic load-test data and exit. |

## Generator options

`npm run loadtest -- [flags]`

| Flag | Default | Meaning |
|---|---|---|
| `--mode` | `check` | `check` (per-send hot path), `report` (opt-out write + cascade), or `mixed` (~90/8/2). |
| `--batch N` | 1 | Identities per check request (1 = realistic per-send; up to 1000 = bulk). |
| `--connections C` | 50 | Concurrent workers (constant-load mode). |
| `--duration S` | 30 | Seconds (constant-load mode). |
| `--ramp a,b,c` | — | Staged ramp of connection counts; overrides `--connections`. |
| `--stage-seconds S` | 20 | Seconds per ramp stage. |
| `--p99-slo MS` | — | Flag stages whose p99 exceeds this; prints a PASS/FAIL verdict. |
| `--out FILE` | — | Write full results as JSON. |
| `--base URL` / `--keys PATH` | from `keys.json` | Override target / keys file. |

---

## Sizing knobs (what to tune before blaming the app)

1. **DB connection pool — `PG_POOL_MAX`** (default **10**). This is the first
   ceiling: node-postgres pools 10 connections by default, so the 11th concurrent
   request *queues*. Raise it for higher traffic — but keep the sum across all app
   instances below Postgres's `max_connections` (default 100), leaving headroom
   for migrations/admin. Start around 20–50 per instance and watch.
2. **Consent-check rate limit — `consentCheckRateLimitPerSec`** (Settings / env).
   The real per-key throttle. Load-test keys bypass it (rate 0); real senders
   don't, so set this to your expected per-sender peak.
3. **Instances + `REDIS_URL`.** The app is stateless per request; run several
   behind a load balancer. Set `REDIS_URL` so the rate limiter is shared across
   instances instead of per-process.
4. **Postgres.** `shared_buffers`, `effective_cache_size`, and connection limits.
   The consent-check hot path is an indexed lookup on `identities.value_normalized`
   plus a join to `consent_states` — cheap when those stay in cache.

---

## Findings from building this (worth knowing)

- **Every consent-check is a write.** `verifyApiKey` updates `last_used_at=now()`
  on the key row on *every* request, so a read-only check still generates WAL and,
  when one high-volume sender funnels through a single key, contends on that row's
  lock. Real deployments with many senders spread this out; a single dominant
  sender does not. If this shows up as a bottleneck, the fix is to sample/throttle
  the `last_used_at` update (e.g. at most once per few seconds per key) or make it
  fire-and-forget. Left as-is for now — flagged here so it's a conscious choice.
- **Pool default of 10 is low for a busy deployment.** Now tunable via
  `PG_POOL_MAX`; see above.

---

## Reference results

Fill this in after a run from a dedicated generator against your-hub.example.edu, so adopters
have a concrete baseline to compare their own hardware against.

| Date | Target (CPU/RAM) | Postgres | `PG_POOL_MAX` | Mode | Peak req/s (p99 ≤ 150ms) | Notes |
|---|---|---|---|---|---|---|
| _TBD_ | your-hub.example.edu (…) | … | … | check, batch 1 | … | first reference run |

> These are *reference* numbers, not guarantees — they depend entirely on the
> box, Postgres tuning, and network. Re-run on your own hardware before relying
> on a figure.
