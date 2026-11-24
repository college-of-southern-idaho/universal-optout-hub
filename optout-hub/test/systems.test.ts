import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSystemFields, HasHistoryError } from '../src/services/systems.js';
import { last4 } from '../src/core/secrets.js';
import {
  requiredCredentialKeys, getAdapterTypeSpec, ADAPTER_CATALOG, ADAPTER_TYPES,
} from '../src/adapters/catalog.js';
import type { SystemRow } from '../src/core/types.js';

function existingRow(p: Partial<SystemRow> & Pick<SystemRow, 'id' | 'adapter_type'>): SystemRow {
  return {
    id: p.id, name: p.name ?? 'Existing', channel: p.channel ?? 'sms',
    category: p.category ?? 'marketing',
    event_delivery: p.event_delivery ?? 'webhook',
    can_write_optout: p.can_write_optout ?? true, can_write_optin: p.can_write_optin ?? true,
    vendor_suppression: p.vendor_suppression ?? null,
    can_discover_topology: p.can_discover_topology ?? true,
    topology_granularity: p.topology_granularity ?? 'pool',
    adapter_type: p.adapter_type, connection_status: p.connection_status ?? 'draft',
    last_test_at: null, last_test_detail: null, created_at: new Date(), archived_at: null,
  };
}

test('new mock system takes catalog defaults', () => {
  const f = resolveSystemFields({ id: 'demo', name: 'Demo', adapter_type: 'mock' }, null);
  assert.equal(f.adapter_type, 'mock');
  assert.equal(f.can_discover_topology, true);
  assert.equal(f.topology_granularity, 'pool');
  assert.equal(f.category, 'marketing');          // default category preserves cascade behavior
});

test('category defaults to marketing, is carried through, and rejects a bad slug', () => {
  assert.equal(resolveSystemFields({ id: 's1', name: 'S', adapter_type: 'mock', category: 'transactional' }, null).category, 'transactional');
  assert.equal(resolveSystemFields({ id: 's2', name: 'S', adapter_type: 'mock' }, null).category, 'marketing');
  assert.throws(() => resolveSystemFields({ id: 's3', name: 'S', adapter_type: 'mock', category: 'Bad Cat!' }, null), /category must be/);
});

test('email_sms_gateway is forced to the sms channel even if email is requested', () => {
  const f = resolveSystemFields(
    { id: 'gw', name: 'Gateway', adapter_type: 'email_sms_gateway', channel: 'email' }, null,
  );
  assert.equal(f.channel, 'sms');                 // consent classification is locked
  assert.equal(f.can_discover_topology, false);
  assert.equal(f.topology_granularity, 'none');
});

test('discovery off pins granularity to none regardless of requested value', () => {
  const f = resolveSystemFields(
    { id: 'tw', name: 'X', adapter_type: 'twilio', can_discover_topology: false, topology_granularity: 'pool' },
    null,
  );
  assert.equal(f.topology_granularity, 'none');
});

test('telesign default cannot write opt-out (no caller-writable list)', () => {
  const f = resolveSystemFields({ id: 'tel', name: 'Tele', adapter_type: 'telesign' }, null);
  assert.equal(f.can_write_optout, false);
  assert.equal(f.can_write_optin, false);
});

test('unknown adapter type is rejected', () => {
  assert.throws(() => resolveSystemFields({ id: 'x', name: 'X', adapter_type: 'smoke_signal' }, null),
    /unknown adapter type/);
});

test('invalid id slug is rejected on create', () => {
  assert.throws(() => resolveSystemFields({ id: 'Bad Id!', name: 'X', adapter_type: 'mock' }, null),
    /id must be/);
});

test('adapter_type is immutable on update (taken from existing row)', () => {
  const existing = existingRow({ id: 'keep', adapter_type: 'twilio' });
  const f = resolveSystemFields({ adapter_type: 'telesign', name: 'Renamed' }, existing);
  assert.equal(f.adapter_type, 'twilio');         // ignores the attempted change
  assert.equal(f.name, 'Renamed');
});

test('missing name is rejected', () => {
  assert.throws(() => resolveSystemFields({ id: 'okid', name: '   ', adapter_type: 'mock' }, null), /name is required/);
});

test('required credential keys come from the catalog', () => {
  // auth_token is optional now (an API Key can replace it); only account_sid is required.
  assert.deepEqual(requiredCredentialKeys('twilio'), ['account_sid']);
  assert.deepEqual(requiredCredentialKeys('mock'), []);
  assert.ok(getAdapterTypeSpec('telesign'));
});

test('last4 reveals only the tail, masks short secrets', () => {
  assert.equal(last4('abcd1234'), '1234');
  assert.equal(last4('xy'), '**');
});

// ---- Expanded catalog -------------------------------------------------------

test('channel-locked email ESP forces channel to email', () => {
  const f = resolveSystemFields({ id: 'mc1', name: 'MC', adapter_type: 'mailchimp', channel: 'sms' }, null);
  assert.equal(f.channel, 'email');
});

test('channel-locked SMS CPaaS forces channel to sms', () => {
  const f = resolveSystemFields({ id: 'von', name: 'V', adapter_type: 'vonage', channel: 'email' }, null);
  assert.equal(f.channel, 'sms');
});

test('omnichannel type (klaviyo) is not locked: defaults email, can switch to sms', () => {
  const dflt = resolveSystemFields({ id: 'kv1', name: 'K', adapter_type: 'klaviyo' }, null);
  assert.equal(dflt.channel, 'email');
  const sms = resolveSystemFields({ id: 'kv2', name: 'K2', adapter_type: 'klaviyo', channel: 'sms' }, null);
  assert.equal(sms.channel, 'sms');
});

test('amazon_ses has a read/write suppression list and no discoverable topology', () => {
  const f = resolveSystemFields({ id: 'ses1', name: 'SES', adapter_type: 'amazon_ses' }, null);
  assert.equal(f.can_write_optout, true);  // add to suppression list
  assert.equal(f.can_write_optin, true);   // remove from suppression list
  assert.equal(f.can_discover_topology, false);
  assert.equal(f.topology_granularity, 'none');
});

test('required credential keys resolve for new types', () => {
  assert.deepEqual(requiredCredentialKeys('sendgrid'), ['api_key']);
  assert.deepEqual(requiredCredentialKeys('mailgun'), ['api_key', 'domain']);
  assert.ok(getAdapterTypeSpec('postmark'));
});

test('HasHistoryError signals archive-instead with a has_history code', () => {
  const e = new HasHistoryError('twilio_main');
  assert.equal(e.code, 'has_history');
  assert.match(e.message, /archive it instead/);
});

test('catalog and ADAPTER_TYPES are consistent (no drift, no dupes)', () => {
  const catalogTypes = ADAPTER_CATALOG.map((a) => a.type);
  assert.deepEqual([...catalogTypes].sort(), [...ADAPTER_TYPES].sort());
  assert.equal(new Set(catalogTypes).size, catalogTypes.length, 'duplicate adapter type');
});

test('every catalog entry is internally consistent', () => {
  for (const spec of ADAPTER_CATALOG) {
    assert.ok(spec.label && spec.blurb, `${spec.type} missing label/blurb`);
    assert.ok(['sms', 'email'].includes(spec.channel), `${spec.type} bad channel`);
    // discovery off ⇒ granularity none
    if (!spec.defaults.can_discover_topology) {
      assert.equal(spec.defaults.topology_granularity, 'none', `${spec.type} granularity should be none`);
    }
    // credential keys unique within a type
    const keys = spec.credentials.map((c) => c.key);
    assert.equal(new Set(keys).size, keys.length, `${spec.type} duplicate credential key`);
  }
});
