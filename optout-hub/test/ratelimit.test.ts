import test from 'node:test';
import assert from 'node:assert/strict';
import { consumeToken, rateLimitCheck, _resetBuckets } from '../src/auth/ratelimit.js';

// --- Pure token-bucket core (ADR-0004 §8) — deterministic, injected clock ----

test('a fresh full bucket allows a request and decrements one token', () => {
  const r = consumeToken({ tokens: 60, lastRefillMs: 0 }, 60, 0);
  assert.equal(r.ok, true);
  assert.equal(r.state.tokens, 59);
  assert.equal(r.retryAfterSec, 0);
});

test('an empty bucket rejects with a whole-second Retry-After', () => {
  const r = consumeToken({ tokens: 0, lastRefillMs: 0 }, 60, 0);
  assert.equal(r.ok, false);
  // 1 token accrues in 1/60 s → ceil → 1s, and never below 1.
  assert.equal(r.retryAfterSec, 1);
  assert.equal(r.state.tokens, 0);
});

test('a slow rate reports the true multi-second wait', () => {
  // 0.5 req/s, empty: one token takes 2s.
  const r = consumeToken({ tokens: 0, lastRefillMs: 0 }, 0.5, 0);
  assert.equal(r.ok, false);
  assert.equal(r.retryAfterSec, 2);
});

test('tokens refill over elapsed time but never exceed capacity', () => {
  // Empty bucket, 10/s, 100s later → would be 1000 but caps at capacity (10).
  const r = consumeToken({ tokens: 0, lastRefillMs: 0 }, 10, 100_000);
  assert.equal(r.ok, true);
  assert.equal(r.state.tokens, 9); // capped at 10, then spent one
});

test('half a refill interval accrues fractional tokens, still enough to spend', () => {
  // 2/s, empty, 600ms later → 1.2 tokens → spend one, 0.2 remain.
  const r = consumeToken({ tokens: 0, lastRefillMs: 0 }, 2, 600);
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.state.tokens - 0.2) < 1e-9);
});

test('a backwards clock never grants extra tokens', () => {
  const r = consumeToken({ tokens: 1, lastRefillMs: 1000 }, 60, 0);
  assert.equal(r.ok, true);
  assert.equal(r.state.tokens, 0); // elapsed clamped to 0, no negative refill
});

// --- Stateful registry (rateLimitCheck) --------------------------------------

test('a key can burst up to its rate, then is throttled', () => {
  _resetBuckets();
  const rate = 5;
  for (let i = 0; i < rate; i++) {
    assert.equal(rateLimitCheck(1, rate, 0).ok, true, `burst request ${i} should pass`);
  }
  const blocked = rateLimitCheck(1, rate, 0);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfterSec >= 1);
});

test('waiting long enough refills the bucket for the same key', () => {
  _resetBuckets();
  const rate = 5;
  for (let i = 0; i < rate; i++) rateLimitCheck(1, rate, 0);
  assert.equal(rateLimitCheck(1, rate, 0).ok, false); // drained at t=0
  // One second later, 5 tokens have refilled.
  assert.equal(rateLimitCheck(1, rate, 1000).ok, true);
});

test('buckets are isolated per key', () => {
  _resetBuckets();
  const rate = 2;
  rateLimitCheck(1, rate, 0);
  rateLimitCheck(1, rate, 0); // key 1 now drained
  assert.equal(rateLimitCheck(1, rate, 0).ok, false);
  assert.equal(rateLimitCheck(2, rate, 0).ok, true); // key 2 untouched
});
