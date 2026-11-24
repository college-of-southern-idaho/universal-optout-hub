import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  signalVineAuth, mapProgramIds, nextPageStart, mapInactiveContacts, extractPhone, extractTimestamp,
  sampleContactKeys,
} from '../src/adapters/signal_vine.js';

// ---- Signature ---------------------------------------------------------------

test('signalVineAuth signs the documented string-to-sign (lowercased except body)', () => {
  const input = {
    token: '123456', secret: 'shh-secret', verb: 'POST', path: '/v1/contact',
    body: '{woo: war}', timestamp: '2014-03-11T05:03:08.619Z',
  };
  // Expected: token/verb/path/timestamp lowercased, body verbatim, HMAC-SHA256(base64) keyed by secret.
  const expectedString = ['123456', 'post', '/v1/contact', '{woo: war}', '2014-03-11t05:03:08.619z'].join('\n');
  const expectedSig = createHmac('sha256', 'shh-secret').update(expectedString, 'utf8').digest('base64');
  assert.equal(signalVineAuth(input), `SignalVine 123456:${expectedSig}`);
});

test('signalVineAuth leaves the body as a blank line when there is none (GET)', () => {
  const sig = signalVineAuth({
    token: 'T', secret: 's', verb: 'GET', path: '/v1/accounts/9', body: '', timestamp: '2026-09-17T00:00:00.000Z',
  });
  const expectedString = ['t', 'get', '/v1/accounts/9', '', '2026-09-17t00:00:00.000z'].join('\n');
  const expectedSig = createHmac('sha256', 's').update(expectedString, 'utf8').digest('base64');
  assert.equal(sig, `SignalVine T:${expectedSig}`);
});

test('signalVineAuth changes when the secret changes (key is the secret)', () => {
  const base = { token: 'T', verb: 'GET', path: '/v1/accounts/9', body: '', timestamp: '2026-09-17T00:00:00.000Z' };
  assert.notEqual(signalVineAuth({ ...base, secret: 'a' }), signalVineAuth({ ...base, secret: 'b' }));
});

// ---- Paging / program mapping -----------------------------------------------

test('mapProgramIds pulls items[].id as strings', () => {
  assert.deepEqual(mapProgramIds({ items: [{ id: 'p1', name: 'A' }, { id: 42 }] }), ['p1', '42']);
  assert.deepEqual(mapProgramIds({ items: [] }), []);
  assert.deepEqual(mapProgramIds({}), []);
});

test('nextPageStart returns the cursor or null when exhausted', () => {
  assert.equal(nextPageStart({ next: 'abc' }), 'abc');
  assert.equal(nextPageStart({ next: '' }), null);
  assert.equal(nextPageStart({ next: null }), null);
  assert.equal(nextPageStart({}), null);
});

// ---- Contact → opt-out mapping ----------------------------------------------

test('mapInactiveContacts turns each contact into an opt_out for its phone', () => {
  const page = { items: [
    { phone: '+12085550140', updated_at: '2026-09-01T12:00:00.000Z' },
    { profile: { mobile: '+12085550141' } },
    { name: 'no phone' },                 // dropped — no phone
  ] };
  const events = mapInactiveContacts(page);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.identity_value), ['+12085550140', '+12085550141']);
  assert.ok(events.every((e) => e.direction === 'opt_out'));
  assert.deepEqual(events[0].occurred_at, new Date('2026-09-01T12:00:00.000Z'));
});

test('mapInactiveContacts is safe on a malformed page', () => {
  assert.deepEqual(mapInactiveContacts({}), []);
  assert.deepEqual(mapInactiveContacts({ items: 'nope' }), []);
});

test('extractPhone checks top-level and nested field objects', () => {
  assert.equal(extractPhone({ phone: '+1208' }), '+1208');
  assert.equal(extractPhone({ fields: { phone_number: '+1209' } }), '+1209');
  assert.equal(extractPhone({ data: { cell: ' +1210 ' } }), '+1210');   // trimmed
  assert.equal(extractPhone({ name: 'x' }), null);
  assert.equal(extractPhone(null), null);
});

test('sampleContactKeys lists top-level + one-level-nested field names (no values)', () => {
  const page = { items: [{ id: 'c1', active: false, profile: { mobilePhone: '+1208', name: 'x' } }] };
  const keys = sampleContactKeys(page);
  assert.ok(keys.includes('id') && keys.includes('active'));
  assert.ok(keys.includes('profile.mobilePhone') && keys.includes('profile.name'));
  // PII-safe: it's field NAMES only, never the value.
  assert.ok(!keys.some((k) => k.includes('+1208')));
  assert.deepEqual(sampleContactKeys({ items: [] }), []);
});

test('extractTimestamp parses a known field or falls back to a Date', () => {
  assert.deepEqual(extractTimestamp({ updated_at: '2026-09-01T00:00:00.000Z' }), new Date('2026-09-01T00:00:00.000Z'));
  assert.ok(extractTimestamp({}) instanceof Date);        // fallback = now
  assert.ok(extractTimestamp({ updated_at: 'garbage' }) instanceof Date);
});
