import test from 'node:test';
import assert from 'node:assert/strict';
import { isExpired, isAuditPrunable, AUDIT_RETAINED_ACTIONS, type RetentionWindows } from '../src/services/retention.js';

// Split-retention prune logic (ADR-0004 §7). Pure classifier, fixed clock.

const W: RetentionWindows = { suppressDays: 1461, otherDays: 90 }; // ~4yr / 90d
const NOW = 1_700_000_000_000; // fixed reference instant (ms)
const DAY = 86_400_000;
const daysAgo = (d: number) => NOW - d * DAY;

test('suppress rows are kept for the long window', () => {
  assert.equal(isExpired('suppress', daysAgo(100), NOW, W), false);
  assert.equal(isExpired('suppress', daysAgo(1460), NOW, W), false);
});

test('suppress rows past ~4 years prune', () => {
  assert.equal(isExpired('suppress', daysAgo(1500), NOW, W), true);
});

test('allow rows use the short window', () => {
  assert.equal(isExpired('allow', daysAgo(30), NOW, W), false);
  assert.equal(isExpired('allow', daysAgo(100), NOW, W), true);
});

test('error rows are treated as non-suppress (short window)', () => {
  assert.equal(isExpired('error', daysAgo(100), NOW, W), true);
  assert.equal(isExpired('error', daysAgo(30), NOW, W), false);
});

test('a suppress row inside the short window is NOT pruned by the allow clock', () => {
  // 120 days > 90 (allow window) but well under the suppress window — must stay.
  assert.equal(isExpired('suppress', daysAgo(120), NOW, W), false);
});

test('the window boundary is exclusive — a row exactly at the window is kept', () => {
  assert.equal(isExpired('allow', daysAgo(90), NOW, W), false);
  assert.equal(isExpired('suppress', daysAgo(1461), NOW, W), false);
});

test('just past the boundary prunes', () => {
  assert.equal(isExpired('allow', NOW - (90 * DAY + 1), NOW, W), true);
});

test('a future-dated row (clock skew) is never expired', () => {
  assert.equal(isExpired('allow', NOW + 10 * DAY, NOW, W), false);
});

// Operational audit_log retention (DESIGN.md §14). Default 14-day window; a few
// compliance-relevant action types are exempt and kept indefinitely.

test('operational audit rows prune once past the window', () => {
  assert.equal(isAuditPrunable('reconcile.scheduled', daysAgo(10), NOW, 14), false);
  assert.equal(isAuditPrunable('reconcile.scheduled', daysAgo(20), NOW, 14), true);
  assert.equal(isAuditPrunable('alert.sync_lag', daysAgo(20), NOW, 14), true);
});

test('compliance-relevant actions are never pruned, however old', () => {
  for (const action of AUDIT_RETAINED_ACTIONS) {
    assert.equal(isAuditPrunable(action, daysAgo(10_000), NOW, 14), false);
  }
});

test('the audit window boundary is exclusive', () => {
  assert.equal(isAuditPrunable('ingest.opt_out', daysAgo(14), NOW, 14), false);
  assert.equal(isAuditPrunable('ingest.opt_out', NOW - (14 * DAY + 1), NOW, 14), true);
});

test('a future-dated audit row (clock skew) is never pruned', () => {
  assert.equal(isAuditPrunable('ingest.opt_out', NOW + 5 * DAY, NOW, 14), false);
});
