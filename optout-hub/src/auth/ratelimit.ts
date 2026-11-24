import type { Request, Response, NextFunction } from 'express';

/**
 * Per-key rate limiting for the consent-check API (ADR-0004 §8).
 *
 * A token bucket per service key: capacity == the per-second rate, so a key
 * may burst up to `rate` requests, then settles to a steady `rate`/sec as the
 * bucket refills. Exceeding it yields `429` with a `Retry-After` (§9).
 *
 * The bucket core is pure and takes an explicit clock so it can be unit-tested
 * without timers or a database (the repo's pure-unit posture). Storage sits
 * behind the `RateLimitStore` interface: the default `InMemoryRateLimitStore`
 * is per-process (fine for a single instance), and a multi-instance deployment
 * swaps in a shared store (see ratelimit-redis.ts) via `setRateLimitStore` so
 * one true limit is enforced across all instances.
 */

export interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

/**
 * Pure token-bucket step. Refills based on elapsed wall-clock, then tries to
 * spend one token. Capacity equals `ratePerSec` (burst == steady-state).
 * Returns the next state and, on rejection, whole seconds until a token frees.
 */
export function consumeToken(
  state: BucketState,
  ratePerSec: number,
  nowMs: number,
): { ok: boolean; state: BucketState; retryAfterSec: number } {
  const capacity = ratePerSec;
  const elapsedSec = Math.max(0, (nowMs - state.lastRefillMs) / 1000);
  const tokens = Math.min(capacity, state.tokens + elapsedSec * ratePerSec);

  if (tokens >= 1) {
    return { ok: true, state: { tokens: tokens - 1, lastRefillMs: nowMs }, retryAfterSec: 0 };
  }
  // Not enough for one token yet; report how long until one accrues (min 1s so
  // a caller never busy-retries with Retry-After: 0).
  const retryAfterSec = Math.max(1, Math.ceil((1 - tokens) / ratePerSec));
  return { ok: false, state: { tokens, lastRefillMs: nowMs }, retryAfterSec };
}

// In-process bucket registry, keyed by service_api_keys.id.
const buckets = new Map<number, BucketState>();

/**
 * Spend one token for `keyId` at the given rate. A key seen for the first time
 * starts with a full bucket (allowed to burst immediately). `nowMs` is injectable
 * for tests; production passes the real clock.
 */
export function rateLimitCheck(
  keyId: number,
  ratePerSec: number,
  nowMs: number = Date.now(),
): { ok: boolean; retryAfterSec: number } {
  const prev = buckets.get(keyId) ?? { tokens: ratePerSec, lastRefillMs: nowMs };
  const r = consumeToken(prev, ratePerSec, nowMs);
  buckets.set(keyId, r.state);
  return { ok: r.ok, retryAfterSec: r.retryAfterSec };
}

/** Test hook: clear all in-memory buckets between cases. */
export function _resetBuckets(): void {
  buckets.clear();
}

export interface RateLimitDecision {
  ok: boolean;
  retryAfterSec: number;
}

/**
 * Pluggable storage for the token buckets. The in-memory default is per-process;
 * a shared implementation (Redis) enforces one limit across instances. `consume`
 * is async so a network-backed store fits behind the same interface.
 */
export interface RateLimitStore {
  consume(keyId: number, ratePerSec: number): Promise<RateLimitDecision>;
}

/** Default store: the in-process token-bucket map. */
export class InMemoryRateLimitStore implements RateLimitStore {
  async consume(keyId: number, ratePerSec: number): Promise<RateLimitDecision> {
    return rateLimitCheck(keyId, ratePerSec);
  }
}

let activeStore: RateLimitStore = new InMemoryRateLimitStore();

/** Swap the active store (e.g. to a shared Redis store at startup). */
export function setRateLimitStore(store: RateLimitStore): void {
  activeStore = store;
}

export function getRateLimitStore(): RateLimitStore {
  return activeStore;
}

/**
 * Middleware: enforce the per-key limit. Must run AFTER `requireApiKey` so
 * `req.apiKey` is populated. A key's own `rate_limit_per_sec` wins; null falls
 * back to `defaultRate`; a rate of 0 (or less) disables limiting for that key.
 *
 * If the store itself errors (e.g. a Redis blip) the request is allowed through
 * — the rate limit is a protection, not a correctness gate, and the fail-closed
 * consent-check must stay available. The error is logged.
 */
export function requireRateLimit(defaultRate: number) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const key = req.apiKey;
    if (!key) {
      next(); // no key on the request — auth middleware will have handled it
      return;
    }
    const rate = key.rate_limit_per_sec ?? defaultRate;
    if (!Number.isFinite(rate) || rate <= 0) {
      next(); // limiting disabled for this key
      return;
    }
    let decision: RateLimitDecision;
    try {
      decision = await activeStore.consume(key.id, rate);
    } catch (e: any) {
      console.error('[ratelimit] store error, allowing request:', e.message);
      next();
      return;
    }
    if (!decision.ok) {
      res.setHeader('Retry-After', String(decision.retryAfterSec));
      res.status(429).json({ error: 'rate limit exceeded', retry_after_seconds: decision.retryAfterSec });
      return;
    }
    next();
  };
}
