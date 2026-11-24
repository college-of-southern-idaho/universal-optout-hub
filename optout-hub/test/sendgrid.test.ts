import test from 'node:test';
import assert from 'node:assert/strict';
import { mapSendGridGroups } from '../src/adapters/sendgrid.js';
import { liveAdapterTypes } from '../src/adapters/registry.js';

test('mapSendGridGroups maps groups to topology nodes', () => {
  const nodes = mapSendGridGroups([
    { id: 100, name: 'Newsletters', description: 'x' },
    { id: '200', name: 'Receipts' },
  ]);
  assert.deepEqual(nodes, [
    { kind: 'group', external_ref: '100', label: 'Newsletters', parent_ref: null },
    { kind: 'group', external_ref: '200', label: 'Receipts', parent_ref: null },
  ]);
});

test('mapSendGridGroups tolerates missing name and junk input', () => {
  assert.deepEqual(mapSendGridGroups([{ id: 7 }]), [
    { kind: 'group', external_ref: '7', label: null, parent_ref: null },
  ]);
  assert.deepEqual(mapSendGridGroups(null), []);
  assert.deepEqual(mapSendGridGroups('nope'), []);
  assert.deepEqual(mapSendGridGroups([null, {}, { id: 1 }]), [
    { kind: 'group', external_ref: '1', label: null, parent_ref: null },
  ]);
});

test('registry registers sendgrid as a live adapter type', () => {
  assert.ok(liveAdapterTypes().includes('sendgrid'));
});
