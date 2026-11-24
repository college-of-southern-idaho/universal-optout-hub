import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeSyncLag } from '../src/services/alerting.js';
import type { SyncLagRow } from '../src/services/reporting.js';

// Build a sync-lag row with just the fields summarizeSyncLag reads; the rest are
// filled with plausible placeholders so the shape type-checks.
function row(p: Partial<SyncLagRow>): SyncLagRow {
  return {
    target_system: 'twilio',
    value_normalized: '+12085550142',
    origin_system: 'sendgrid',
    optout_occurred_at: new Date(0),
    issued_at: new Date(0),
    confirmed_at: null,
    lag_seconds: 3600,
    business_days: 1,
    converged: false,
    severity: 'ok',
    ...p,
  };
}

test('returns null when nothing is lagging (all ok/converged)', () => {
  const rows = [row({ severity: 'ok' }), row({ severity: 'ok', lag_seconds: 999_999 })];
  assert.equal(summarizeSyncLag(rows), null);
});

test('returns null for an empty report', () => {
  assert.equal(summarizeSyncLag([]), null);
});

test('counts breaches and warnings and reports the worst lag in hours', () => {
  const rows = [
    row({ severity: 'ok', lag_seconds: 60 }),                 // ignored
    row({ severity: 'warn', lag_seconds: 25 * 3600 }),        // 25h warn
    row({ severity: 'breach', lag_seconds: 40 * 3600 }),      // 40h breach
    row({ severity: 'breach', lag_seconds: 30 * 3600 }),      // 30h breach
  ];
  const alert = summarizeSyncLag(rows)!;
  assert.ok(alert);
  assert.equal(alert.breaches, 2);
  assert.equal(alert.warns, 1);
  assert.equal(alert.worstLagHours, 40);
});

test('includes up to 5 examples with human-readable lag hours', () => {
  const rows = Array.from({ length: 7 }, (_, i) =>
    row({ severity: 'breach', value_normalized: `+1208555000${i}`, lag_seconds: (i + 1) * 3600 }),
  );
  const alert = summarizeSyncLag(rows)!;
  assert.equal(alert.examples.length, 5);
  assert.deepEqual(alert.examples[0], {
    identity: '+12085550000',
    target_system: 'twilio',
    lag_hours: 1,
    severity: 'breach',
  });
});

test('rounds fractional lag hours to the nearest hour', () => {
  const alert = summarizeSyncLag([row({ severity: 'warn', lag_seconds: 90 * 60 })])!; // 1.5h
  assert.equal(alert.worstLagHours, 2);
  assert.equal(alert.examples[0].lag_hours, 2);
});
