/**
 * Per-IP login throttle. A defense-in-depth layer on top of the
 * DB-backed per-account lockout (users.ts): the account lockout stops one
 * account being hammered; this stops one source address spraying many accounts
 * (credential stuffing) from a single IP.
 *
 * Only FAILED attempts count, and a success clears the counter — so a
 * legitimate user who mistypes a few times is never blocked; sustained failure
 * from an address is. Per-process (in-memory): in a multi-instance deployment
 * each instance throttles independently, which is fine — the shared authority
 * is the per-account lockout in the database.
 *
 * The core is pure with an injectable clock (repo's pure-unit posture); the
 * Map-backed manager wraps it.
 */

export interface ThrottleConfig {
  maxFailures: number; // failures within the window before the IP is blocked (0 disables)
  windowMs: number;    // rolling window over which failures are counted
  blockMs: number;     // how long a block lasts once tripped
}

export interface ThrottleState {
  failures: number;
  windowStartMs: number;
  blockedUntilMs: number;
}

function minutes(env: string | undefined, fallback: number): number {
  const n = Number(env);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Config from env, read once. Defaults: 10 failures / 15 min → 15 min block. */
export const config: ThrottleConfig = {
  maxFailures: minutes(process.env.LOGIN_THROTTLE_MAX_FAILURES, 10),
  windowMs: minutes(process.env.LOGIN_THROTTLE_WINDOW_MINUTES, 15) * 60_000,
  blockMs: minutes(process.env.LOGIN_THROTTLE_BLOCK_MINUTES, 15) * 60_000,
};

/** Pure: is an attempt allowed now? Blocked only while `blockedUntilMs` is future. */
export function throttleAllows(
  state: ThrottleState | undefined, nowMs: number,
): { allowed: boolean; retryAfterSec: number } {
  if (state && state.blockedUntilMs > nowMs) {
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((state.blockedUntilMs - nowMs) / 1000)) };
  }
  return { allowed: true, retryAfterSec: 0 };
}

/**
 * Pure: fold a failed attempt into the state. Failures older than the window
 * reset the count; reaching `maxFailures` trips a block for `blockMs`.
 */
export function recordFailure(
  state: ThrottleState | undefined, nowMs: number, cfg: ThrottleConfig,
): ThrottleState {
  let failures = state?.failures ?? 0;
  let windowStartMs = state?.windowStartMs ?? nowMs;
  if (nowMs - windowStartMs >= cfg.windowMs) {
    failures = 0;
    windowStartMs = nowMs;
  }
  failures += 1;
  let blockedUntilMs = state?.blockedUntilMs ?? 0;
  if (cfg.maxFailures > 0 && failures >= cfg.maxFailures) {
    blockedUntilMs = nowMs + cfg.blockMs;
    failures = 0;              // reset the counter; the block itself is the gate now
    windowStartMs = nowMs;
  }
  return { failures, windowStartMs, blockedUntilMs };
}

// ---- In-memory manager, keyed by client IP -------------------------------

const states = new Map<string, ThrottleState>();

/** Check whether this IP may attempt a login now. Disabled when maxFailures<=0. */
export function loginThrottleCheck(ip: string, nowMs: number = Date.now()) {
  if (config.maxFailures <= 0) return { allowed: true, retryAfterSec: 0 };
  return throttleAllows(states.get(ip), nowMs);
}

/** Record a failed login from this IP. */
export function loginThrottleFailure(ip: string, nowMs: number = Date.now()): void {
  if (config.maxFailures <= 0) return;
  states.set(ip, recordFailure(states.get(ip), nowMs, config));
}

/** Clear an IP's counter after a successful login. */
export function loginThrottleReset(ip: string): void {
  states.delete(ip);
}

/** Test hook: clear all throttle state. */
export function _resetLoginThrottle(): void {
  states.clear();
}
