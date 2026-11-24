import test from 'node:test';
import assert from 'node:assert/strict';
import { nextCursor } from '../src/services/poller.js';
import type { PolledEvent } from '../src/adapters/contract.js';

const ev = (iso: string): PolledEvent => ({ identity_value: 'x', direction: 'opt_out', occurred_at: new Date(iso) });

test('nextCursor advances to the newest event time', () => {
  const c = nextCursor('2026-08-01T00:00:00.000Z', [ev('2026-08-03T00:00:00.000Z'), ev('2026-08-02T00:00:00.000Z')]);
  assert.equal(c, '2026-08-03T00:00:00.000Z');
});

test('nextCursor keeps the previous cursor when nothing newer arrived', () => {
  const prev = '2026-08-05T00:00:00.000Z';
  assert.equal(nextCursor(prev, [ev('2026-08-01T00:00:00.000Z')]), prev);
  assert.equal(nextCursor(prev, []), prev);
});

test('nextCursor from a null cursor uses the newest event, or stays null when empty', () => {
  assert.equal(nextCursor(null, [ev('2026-08-02T00:00:00.000Z')]), '2026-08-02T00:00:00.000Z');
  assert.equal(nextCursor(null, []), null);
});
