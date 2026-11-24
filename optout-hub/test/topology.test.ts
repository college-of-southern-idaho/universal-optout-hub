import test from 'node:test';
import assert from 'node:assert/strict';
import { diffTopology, type ExistingNode } from '../src/services/topology.js';
import type { DiscoveredNode } from '../src/core/types.js';

function existing(p: Partial<ExistingNode> & Pick<ExistingNode, 'external_ref'>): ExistingNode {
  return {
    kind: 'code', label: null, parent_ref: null, decommissioned_at: null, ...p,
  };
}
function discovered(p: Partial<DiscoveredNode> & Pick<DiscoveredNode, 'external_ref'>): DiscoveredNode {
  return { kind: 'code', label: null, parent_ref: null, ...p };
}

test('empty hub: every discovered node is added', () => {
  const d = diffTopology([], [
    discovered({ kind: 'pool', external_ref: 'p1', label: 'Admissions' }),
    discovered({ external_ref: '+1555', parent_ref: 'p1' }),
  ]);
  assert.equal(d.added.length, 2);
  assert.equal(d.updated.length, 0);
  assert.equal(d.decommissioned.length, 0);
});

test('unchanged node is neither added nor updated', () => {
  const d = diffTopology(
    [existing({ external_ref: '+1555', parent_ref: 'p1', label: 'Line 1' })],
    [discovered({ external_ref: '+1555', parent_ref: 'p1', label: 'Line 1' })],
  );
  assert.equal(d.unchanged, 1);
  assert.equal(d.added.length, 0);
  assert.equal(d.updated.length, 0);
});

test('a changed label or parent counts as updated', () => {
  const byLabel = diffTopology(
    [existing({ external_ref: '+1555', label: 'Old' })],
    [discovered({ external_ref: '+1555', label: 'New' })],
  );
  assert.equal(byLabel.updated.length, 1);

  const byParent = diffTopology(
    [existing({ external_ref: '+1555', parent_ref: 'p1' })],
    [discovered({ external_ref: '+1555', parent_ref: 'p2' })],
  );
  assert.equal(byParent.updated.length, 1);
});

test('node absent from discovery is decommissioned, not deleted', () => {
  const d = diffTopology(
    [existing({ external_ref: '+1555' }), existing({ external_ref: '+1556' })],
    [discovered({ external_ref: '+1555' })],
  );
  assert.deepEqual(d.decommissioned, [{ kind: 'code', external_ref: '+1556' }]);
});

test('an already-decommissioned node is not decommissioned again', () => {
  const d = diffTopology(
    [existing({ external_ref: '+1556', decommissioned_at: new Date('2026-01-01') })],
    [],
  );
  assert.equal(d.decommissioned.length, 0);
});

test('a decommissioned node that reappears is reactivated, not re-added', () => {
  const d = diffTopology(
    [existing({ external_ref: '+1555', decommissioned_at: new Date('2026-01-01') })],
    [discovered({ external_ref: '+1555' })],
  );
  assert.equal(d.reactivated.length, 1);
  assert.equal(d.added.length, 0);
});

test('kind is part of node identity (same ref, different kind → distinct)', () => {
  const d = diffTopology(
    [existing({ kind: 'pool', external_ref: 'x' })],
    [discovered({ kind: 'code', external_ref: 'x' })],
  );
  // The pool 'x' is gone from discovery; the code 'x' is new.
  assert.equal(d.added.length, 1);
  assert.equal(d.added[0].kind, 'code');
  assert.deepEqual(d.decommissioned, [{ kind: 'pool', external_ref: 'x' }]);
});
