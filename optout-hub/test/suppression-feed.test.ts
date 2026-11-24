import test from 'node:test';
import assert from 'node:assert/strict';
import { isSuppressingState, suppressionWatermark } from '../src/services/consent-check.js';

// Pure helpers behind GET /api/v1/consent/suppressions (ADR-0004 §2.4).

test('isSuppressingState: opt-out and propagated suppression withhold; others do not', () => {
  assert.equal(isSuppressingState('opted_out'), true);
  assert.equal(isSuppressingState('suppressed'), true);
  assert.equal(isSuppressingState('opted_in'), false);
  assert.equal(isSuppressingState('unknown'), false);
});

test('watermark: newest entry timestamp when rows returned', () => {
  const now = '2026-07-30T12:00:00.000Z';
  const wm = suppressionWatermark(
    ['2026-07-01T00:00:00.000Z', '2026-07-15T00:00:00.000Z', '2026-07-10T00:00:00.000Z'],
    undefined,
    now,
  );
  assert.equal(wm, '2026-07-15T00:00:00.000Z');
});

test('watermark: empty delta keeps the caller cursor (since)', () => {
  const since = '2026-07-20T00:00:00.000Z';
  const wm = suppressionWatermark([], since, '2026-07-30T12:00:00.000Z');
  assert.equal(wm, since);
});

test('watermark: empty baseline (no since) falls back to now', () => {
  const now = '2026-07-30T12:00:00.000Z';
  const wm = suppressionWatermark([], undefined, now);
  assert.equal(wm, now);
});
