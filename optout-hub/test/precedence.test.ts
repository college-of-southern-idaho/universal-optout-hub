import test from 'node:test';
import assert from 'node:assert/strict';
import { foldState } from '../src/core/precedence.js';
import type { ConsentEvent } from '../src/core/types.js';

let nextId = 1;
function ev(
  direction: 'opt_in' | 'opt_out',
  provenance: 'explicit' | 'derived',
  occurredAt: string,
): ConsentEvent {
  return {
    id: nextId++,
    identity_id: 1,
    system_id: 'sys',
    channel: 'sms',
    direction,
    provenance,
    occurred_at: new Date(occurredAt),
    source_detail: null,
  };
}

test('empty log is unknown', () => {
  assert.deepEqual(foldState([]).state, 'unknown');
});

test('explicit opt-in then explicit opt-out → opted_out', () => {
  const s = foldState([
    ev('opt_in', 'explicit', '2026-01-01'),
    ev('opt_out', 'explicit', '2026-01-02'),
  ]);
  assert.equal(s.state, 'opted_out');
  assert.equal(s.provenance, 'explicit');
});

test('rule 3: explicit opt-in overrides prior explicit opt-out (STOP then START)', () => {
  const s = foldState([
    ev('opt_out', 'explicit', '2026-01-01'),
    ev('opt_in', 'explicit', '2026-01-02'),
  ]);
  assert.equal(s.state, 'opted_in');
  assert.equal(s.provenance, 'explicit');
});

test('rule 1: derived opt-in never overrides explicit opt-out', () => {
  const s = foldState([
    ev('opt_out', 'explicit', '2026-01-01'),
    ev('opt_in', 'derived', '2026-01-02'),
  ]);
  assert.equal(s.state, 'opted_out');
  assert.equal(s.provenance, 'explicit');
});

test('derived opt-in applies over derived suppression', () => {
  const s = foldState([
    ev('opt_out', 'derived', '2026-01-01'),
    ev('opt_in', 'derived', '2026-01-02'),
  ]);
  assert.equal(s.state, 'opted_in');
  assert.equal(s.provenance, 'derived');
});

test('rule 2: derived opt-out suppresses an explicit opt-in (safety asymmetry)', () => {
  const s = foldState([
    ev('opt_in', 'explicit', '2026-01-01'),
    ev('opt_out', 'derived', '2026-01-02'),
  ]);
  assert.equal(s.state, 'suppressed');
  assert.equal(s.provenance, 'derived');
});

test('rule 2: derived opt-out leaves explicit opt-out untouched', () => {
  const s = foldState([
    ev('opt_out', 'explicit', '2026-01-01'),
    ev('opt_out', 'derived', '2026-01-02'),
  ]);
  assert.equal(s.state, 'opted_out');
  assert.equal(s.provenance, 'explicit');
});

test('fold orders by occurred_at, not insertion order (late-arriving events)', () => {
  // Inserted out of order: the opt-out occurred LAST even though it was
  // recorded first.
  const optOut = ev('opt_out', 'explicit', '2026-01-03');
  const optIn = ev('opt_in', 'explicit', '2026-01-02');
  const s = foldState([optOut, optIn]);
  assert.equal(s.state, 'opted_out');
});

test('same-timestamp ties resolve by event id (insertion order)', () => {
  const a = ev('opt_in', 'explicit', '2026-01-01T00:00:00Z');
  const b = ev('opt_out', 'explicit', '2026-01-01T00:00:00Z');
  const s = foldState([a, b]);
  assert.equal(s.state, 'opted_out'); // b has the higher id → applies last
});
