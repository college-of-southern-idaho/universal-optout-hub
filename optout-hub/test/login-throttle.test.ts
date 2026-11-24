import test from 'node:test';
import assert from 'node:assert/strict';
import { throttleAllows, recordFailure, type ThrottleConfig, type ThrottleState } from '../src/auth/login-throttle.js';

const CFG: ThrottleConfig = { maxFailures: 3, windowMs: 60_000, blockMs: 300_000 };
const T0 = 1_000_000_000_000;

test('a fresh IP (no state) is allowed', () => {
  assert.deepEqual(throttleAllows(undefined, T0), { allowed: true, retryAfterSec: 0 });
});

test('failures below the threshold do not block', () => {
  let s: ThrottleState | undefined;
  s = recordFailure(s, T0, CFG);
  s = recordFailure(s, T0 + 1000, CFG);
  assert.equal(s.failures, 2);
  assert.equal(throttleAllows(s, T0 + 2000).allowed, true);
});

test('reaching maxFailures trips a block for blockMs', () => {
  let s: ThrottleState | undefined;
  s = recordFailure(s, T0, CFG);
  s = recordFailure(s, T0 + 1000, CFG);
  s = recordFailure(s, T0 + 2000, CFG); // 3rd failure → block
  const gate = throttleAllows(s, T0 + 2000);
  assert.equal(gate.allowed, false);
  assert.equal(gate.retryAfterSec, 300); // full blockMs remaining
});

test('the block expires after blockMs', () => {
  let s: ThrottleState | undefined;
  for (let i = 0; i < 3; i++) s = recordFailure(s, T0 + i, CFG);
  assert.equal(throttleAllows(s, T0 + CFG.blockMs + 5).allowed, true);
});

test('failures older than the window reset the counter (legit user not blocked)', () => {
  let s: ThrottleState | undefined;
  s = recordFailure(s, T0, CFG);
  s = recordFailure(s, T0 + 1000, CFG);            // 2 failures
  s = recordFailure(s, T0 + CFG.windowMs + 1, CFG); // window elapsed → counts as 1
  assert.equal(s.failures, 1);
  assert.equal(throttleAllows(s, T0 + CFG.windowMs + 1).allowed, true);
});

test('maxFailures = 0 never blocks (disabled)', () => {
  const off: ThrottleConfig = { ...CFG, maxFailures: 0 };
  let s: ThrottleState | undefined;
  for (let i = 0; i < 25; i++) s = recordFailure(s, T0 + i, off);
  assert.equal(throttleAllows(s, T0 + 100).allowed, true);
});
