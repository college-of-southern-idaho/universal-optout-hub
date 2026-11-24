import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapTelesignInbound, telesignCallbackSignature, verifyTelesignSignature, parseTelesignAuthHeader,
} from '../src/services/webhooks.js';
import { TelesignAdapter } from '../src/adapters/telesign.js';
import type { SystemRow } from '../src/core/types.js';

const moCallback = (action: string, phone = '12085550142') => ({
  reference_id: 'ref1',
  sub_resource: 'mo_sms',
  submit_timestamp: '2026-08-20T14:00:00Z',
  user_response: { phone_number: phone, mo_message: action, keyword: action.toLowerCase(), action },
});

// --- Inbound MO callback mapping ---------------------------------------------

test('STOP maps to opt-out, START to opt-in, with a + on the number', () => {
  const stop = mapTelesignInbound(moCallback('stop'));
  assert.equal(stop?.direction, 'opt_out');
  assert.equal(stop?.identity, '+12085550142');
  assert.equal(stop?.occurred_at?.toISOString(), '2026-08-20T14:00:00.000Z');

  const start = mapTelesignInbound(moCallback('start'));
  assert.equal(start?.direction, 'opt_in');
});

test('help / generic / unknown actions are ignored', () => {
  assert.equal(mapTelesignInbound(moCallback('help')), null);
  assert.equal(mapTelesignInbound(moCallback('generic')), null);
  assert.equal(mapTelesignInbound({}), null);
  assert.equal(mapTelesignInbound({ user_response: {} }), null);
});

test('a number that already has a + is left alone', () => {
  const e = mapTelesignInbound(moCallback('stop', '+441234567890'));
  assert.equal(e?.identity, '+441234567890');
});

// --- Callback signature verification -----------------------------------------

test('a correctly signed callback verifies; tampering fails', () => {
  const apiKey = Buffer.from('super-secret-key').toString('base64'); // Telesign keys are base64
  const body = Buffer.from(JSON.stringify(moCallback('stop')), 'utf8');
  const sig = telesignCallbackSignature(apiKey, body);
  const header = `TSA CUSTOMER123:${sig}`;

  assert.equal(verifyTelesignSignature(apiKey, body, header), true);
  assert.equal(verifyTelesignSignature(apiKey, body, `TSA CUSTOMER123:${sig}x`), false); // bad sig
  assert.equal(verifyTelesignSignature(apiKey, Buffer.from('{}'), header), false);       // body changed
  assert.equal(verifyTelesignSignature(apiKey, body, undefined), false);                 // no header
  assert.equal(verifyTelesignSignature('', body, header), false);                        // no key
});

test('parseTelesignAuthHeader extracts the signature from the TSA header', () => {
  assert.equal(parseTelesignAuthHeader('TSA CUST:abc123=='), 'abc123==');
  assert.equal(parseTelesignAuthHeader('Bearer nope'), null);
  assert.equal(parseTelesignAuthHeader(undefined), null);
});

// --- Withhold-only adapter contract ------------------------------------------

const sys = { id: 'ts1', can_discover_topology: false } as unknown as SystemRow;

test('Telesign is withhold-only: writes are refused, never silently accepted', async () => {
  const a = new TelesignAdapter(sys, { customer_id: 'c', api_key: 'k' });
  const out = await a.write('+12085550142', 'opt_out', 'key');
  assert.equal(out.ok, false);
  assert.match(out.reason ?? '', /withhold-only/);
});

test('observe has no readable state (returns none); topology is annotate-only', async () => {
  const a = new TelesignAdapter(sys, { customer_id: 'c', api_key: 'k' });
  assert.equal(await a.observe('+12085550142'), 'none');
  assert.deepEqual(await a.discoverTopology(), []);
});
