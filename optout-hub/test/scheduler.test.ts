import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleFrom, guarded } from '../src/services/scheduler.js';

// --- Interval values → milliseconds ------------------------------------------

test('converts minutes/hours into milliseconds', () => {
  const c = scheduleFrom(15, 24, 5, 30);
  assert.equal(c.reconcileEveryMs, 15 * 60_000);
  assert.equal(c.pruneEveryMs, 24 * 3_600_000);
  assert.equal(c.pollEveryMs, 5 * 60_000);
  assert.equal(c.alertEveryMs, 30 * 60_000);
});

test('zero, negative, or non-numeric → disabled (0)', () => {
  assert.deepEqual(scheduleFrom(0, 0, 0, 0), { reconcileEveryMs: 0, pruneEveryMs: 0, pollEveryMs: 0, alertEveryMs: 0 });
  assert.deepEqual(scheduleFrom(0, -1, NaN, -5), { reconcileEveryMs: 0, pruneEveryMs: 0, pollEveryMs: 0, alertEveryMs: 0 });
});

test('fractional intervals are allowed and rounded to whole ms', () => {
  const c = scheduleFrom(0.5, 0, 0, 0);
  assert.equal(c.reconcileEveryMs, 30_000);
});

// --- Overlap guard -----------------------------------------------------------

test('guarded skips a call while a prior run is still in flight', async () => {
  let release = () => {};
  let runs = 0;
  const gate = new Promise<void>((r) => { release = () => r(); });
  const job = guarded(async () => { runs++; await gate; return 'done'; });

  const first = job();          // starts, blocks on the gate
  const second = await job();   // fires while first is in flight → skipped
  assert.equal(second, 'skipped');
  assert.equal(runs, 1);

  release();
  assert.equal(await first, 'done');

  // Once the first finishes, a later call runs normally again.
  const third = await job();
  assert.equal(third, 'done');
  assert.equal(runs, 2);
});

test('guarded resets the lock even when the job throws', async () => {
  let calls = 0;
  const job = guarded(async () => { calls++; throw new Error('boom'); });
  await assert.rejects(job(), /boom/);
  await assert.rejects(job(), /boom/);  // not wedged after the throw
  assert.equal(calls, 2);
});
