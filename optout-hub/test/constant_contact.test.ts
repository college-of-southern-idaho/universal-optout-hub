import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapPermission, firstContact, mapContactLists, mapPolledUnsubscribes,
} from '../src/adapters/constant_contact.js';

// Pure mappers for the Constant Contact v3 adapter.

test('permission_to_send maps to the hub observe result', () => {
  assert.equal(mapPermission('unsubscribed'), 'opted_out');
  assert.equal(mapPermission('temp_hold'), 'opted_out');
  assert.equal(mapPermission('explicit'), 'opted_in');
  // implicit / pending / not_set / missing are not a positive consent record
  assert.equal(mapPermission('implicit'), 'none');
  assert.equal(mapPermission('pending_confirmation'), 'none');
  assert.equal(mapPermission('not_set'), 'none');
  assert.equal(mapPermission(undefined), 'none');
});

test('firstContact pulls the first contact with an id, else null', () => {
  assert.equal(firstContact({ contacts: [{ contact_id: 'c1', email_address: { permission_to_send: 'explicit' } }] })?.contact_id, 'c1');
  assert.equal(firstContact({ contacts: [] }), null);
  assert.equal(firstContact({}), null);
  assert.equal(firstContact(null), null);
});

test('contact_lists map to group topology nodes', () => {
  const nodes = mapContactLists({ lists: [
    { list_id: 'L1', name: 'Newsletter' },
    { list_id: 'L2', name: 'Events' },
    { name: 'no id — skipped' },
  ] });
  assert.deepEqual(nodes, [
    { kind: 'group', external_ref: 'L1', label: 'Newsletter', parent_ref: null },
    { kind: 'group', external_ref: 'L2', label: 'Events', parent_ref: null },
  ]);
  assert.deepEqual(mapContactLists({}), []);
});

test('polled unsubscribes map to opt-out events, sorted ascending', () => {
  const events = mapPolledUnsubscribes({ contacts: [
    { email_address: { address: 'b@example.com' }, updated_at: '2026-08-02T00:00:00Z' },
    { email_address: { address: 'a@example.com' }, updated_at: '2026-08-01T00:00:00Z' },
  ] }, null);
  assert.equal(events.length, 2);
  assert.equal(events[0].identity_value, 'a@example.com');       // earliest first
  assert.equal(events[0].direction, 'opt_out');
  assert.ok(events[0].occurred_at < events[1].occurred_at);
});

test('the cursor filters out already-ingested unsubscribes (updated_at <= since)', () => {
  const contacts = [
    { email_address: { address: 'old@example.com' }, updated_at: '2026-08-01T00:00:00Z' },
    { email_address: { address: 'new@example.com' }, updated_at: '2026-08-03T00:00:00Z' },
  ];
  const events = mapPolledUnsubscribes({ contacts }, '2026-08-02T00:00:00Z');
  assert.deepEqual(events.map((e) => e.identity_value), ['new@example.com']);
});

test('contacts without an email or timestamp are skipped', () => {
  const events = mapPolledUnsubscribes({ contacts: [
    { email_address: {}, updated_at: '2026-08-01T00:00:00Z' }, // no address
    { email_address: { address: 'x@example.com' } },           // no timestamp
    { email_address: { address: 'ok@example.com' }, updated_at: '2026-08-01T00:00:00Z' },
  ] }, null);
  assert.deepEqual(events.map((e) => e.identity_value), ['ok@example.com']);
});
