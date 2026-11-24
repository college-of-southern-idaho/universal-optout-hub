import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReportInput, CheckRequestError } from '../src/services/consent-check.js';

test('validates and normalizes an opt-out report (phone)', () => {
  const r = validateReportInput({ value: '(208) 555-0142', direction: 'opt_out' });
  assert.equal(r.direction, 'opt_out');
  assert.equal(r.normalized, '+12085550142'); // E.164 normalized
  assert.equal(r.occurred_at, undefined);
});

test('parses an ISO occurred_at', () => {
  const r = validateReportInput({ value: 'a@b.com', direction: 'opt_in', occurred_at: '2026-08-28T17:00:00Z' });
  assert.equal(r.direction, 'opt_in');
  assert.ok(r.occurred_at instanceof Date);
  assert.equal(r.occurred_at!.toISOString(), '2026-08-28T17:00:00.000Z');
});

test('rejects a bad direction', () => {
  assert.throws(() => validateReportInput({ value: '+12085550142', direction: 'stop' as any }), CheckRequestError);
});

test('rejects a missing value', () => {
  assert.throws(() => validateReportInput({ value: '', direction: 'opt_out' }), CheckRequestError);
});

test('rejects an unnormalizable value', () => {
  assert.throws(() => validateReportInput({ value: 'not-a-phone-or-email', direction: 'opt_out' }), CheckRequestError);
});

test('rejects an invalid occurred_at', () => {
  assert.throws(() => validateReportInput({ value: '+12085550142', direction: 'opt_out', occurred_at: 'yesterday' }), CheckRequestError);
});
