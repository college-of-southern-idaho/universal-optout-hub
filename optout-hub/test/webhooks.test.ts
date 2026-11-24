import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import {
  mapTwilioInbound, mapTwilioEvents, routeTwilioEvent, twilioSignature, verifyTwilioSignature,
  mapSendgridEvents, verifySendgridSignature,
} from '../src/services/webhooks.js';

// --- Twilio inbound mapping --------------------------------------------------

test('Twilio OptOutType STOP/START map to opt_out/opt_in', () => {
  assert.equal(mapTwilioInbound({ From: '+12084207280', OptOutType: 'STOP' })?.direction, 'opt_out');
  assert.equal(mapTwilioInbound({ From: '+12084207280', OptOutType: 'START' })?.direction, 'opt_in');
});

test('Twilio HELP and non-keyword bodies are ignored', () => {
  assert.equal(mapTwilioInbound({ From: '+12084207280', OptOutType: 'HELP' }), null);
  assert.equal(mapTwilioInbound({ From: '+12084207280', Body: 'when is orientation?' }), null);
});

test('Twilio falls back to Body keyword when OptOutType is absent', () => {
  assert.equal(mapTwilioInbound({ From: '+12084207280', Body: 'STOP please' })?.direction, 'opt_out');
  assert.equal(mapTwilioInbound({ From: '+12084207280', Body: 'start' })?.direction, 'opt_in');
  assert.equal(mapTwilioInbound({ Body: 'STOP' }), null); // no From
});

// --- Twilio Event Streams (CloudEvents inbound-message) ----------------------

const EV = 'com.twilio.messaging.inbound-message.received';
const cev = (data: any, time?: string) => ({ specversion: '1.0', type: EV, time, data });

test('Event Streams optOutType STOP/START map to opt_out/opt_in', () => {
  const out = mapTwilioEvents([
    cev({ from: '+12084207280', optOutType: 'STOP', messageSid: 'SM1' }),
    cev({ from: '+12084207281', optOutType: 'START', messageSid: 'SM2' }),
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((e) => e.direction), ['opt_out', 'opt_in']);
  assert.deepEqual(out.map((e) => e.eventId), ['SM1', 'SM2']);
  assert.equal(out[0].identity, '+12084207280');
});

test('Event Streams accepts a single CloudEvent object, not just an array', () => {
  const out = mapTwilioEvents(cev({ from: '+12084207280', optOutType: 'STOP' }));
  assert.equal(out.length, 1);
  assert.equal(out[0].direction, 'opt_out');
});

test('Event Streams carries the envelope time as occurred_at (bad time ignored)', () => {
  const [ok] = mapTwilioEvents(cev({ from: '+1', optOutType: 'STOP' }, '2026-08-31T12:00:00Z'));
  assert.equal(ok.occurred_at?.toISOString(), '2026-08-31T12:00:00.000Z');
  const [bad] = mapTwilioEvents(cev({ from: '+1', optOutType: 'STOP' }, 'not-a-date'));
  assert.equal(bad.occurred_at, undefined);
});

test('Event Streams falls back to the body keyword when optOutType is absent', () => {
  assert.equal(mapTwilioEvents(cev({ from: '+1', body: 'STOP please' }))[0]?.direction, 'opt_out');
  assert.equal(mapTwilioEvents(cev({ from: '+1', body: 'start' }))[0]?.direction, 'opt_in');
});

test('Event Streams ignores HELP, non-keywords, other event types, and missing from', () => {
  assert.equal(mapTwilioEvents(cev({ from: '+1', optOutType: 'HELP' })).length, 0);
  assert.equal(mapTwilioEvents(cev({ from: '+1', body: 'when is orientation?' })).length, 0);
  assert.equal(mapTwilioEvents({ type: 'com.twilio.messaging.message.status.updated', data: { from: '+1', body: 'STOP' } }).length, 0);
  assert.equal(mapTwilioEvents(cev({ optOutType: 'STOP' })).length, 0); // no from
  assert.equal(mapTwilioEvents(null).length, 0);
});

test('Event Streams surfaces the Messaging Service SID for routing', () => {
  const [e] = mapTwilioEvents(cev({ from: '+1', optOutType: 'STOP', messagingServiceSid: 'MG123' }));
  assert.equal(e.routeMsSid, 'MG123');
});

test('routeTwilioEvent routes by Messaging Service SID, falls back to the default system', () => {
  const map = new Map([['MG_mkt', 'sys_mkt'], ['MG_txn', 'sys_txn']]);
  assert.equal(routeTwilioEvent('MG_mkt', map, 'sys_default'), 'sys_mkt');
  assert.equal(routeTwilioEvent('MG_txn', map, 'sys_default'), 'sys_txn');
  assert.equal(routeTwilioEvent('MG_unregistered', map, 'sys_default'), 'sys_default');
  assert.equal(routeTwilioEvent(undefined, map, 'sys_default'), 'sys_default');
});

// --- Twilio signature (HMAC-SHA1) --------------------------------------------

test('Twilio signature verifies and rejects tampering', () => {
  const token = 'test_auth_token';
  const url = 'https://hub.example.edu/api/webhooks/twilio/admissions';
  const params = { From: '+12084207280', Body: 'STOP', To: '+12085550000' };
  const sig = twilioSignature(token, url, params);
  assert.equal(verifyTwilioSignature(token, url, params, sig), true);
  assert.equal(verifyTwilioSignature(token, url, { ...params, Body: 'START' }, sig), false); // tampered param
  assert.equal(verifyTwilioSignature('wrong_token', url, params, sig), false);
  assert.equal(verifyTwilioSignature(token, url, params, undefined), false);
});

// --- SendGrid event mapping --------------------------------------------------

test('SendGrid suppression events map to opt_out; resubscribe to opt_in; rest ignored', () => {
  const out = mapSendgridEvents([
    { email: 'a@x.edu', event: 'unsubscribe', timestamp: 1_700_000_000 },
    { email: 'b@x.edu', event: 'group_unsubscribe', timestamp: 1_700_000_100 },
    { email: 'c@x.edu', event: 'spamreport' },
    { email: 'd@x.edu', event: 'group_resubscribe' },
    { email: 'e@x.edu', event: 'delivered' },   // ignored
    { email: 'f@x.edu', event: 'open' },         // ignored
  ]);
  assert.deepEqual(out.map((e) => [e.identity, e.direction]), [
    ['a@x.edu', 'opt_out'], ['b@x.edu', 'opt_out'], ['c@x.edu', 'opt_out'], ['d@x.edu', 'opt_in'],
  ]);
  assert.equal(out[0].occurred_at?.getTime(), 1_700_000_000 * 1000); // unix seconds → ms
});

test('SendGrid mapper tolerates non-array / malformed input', () => {
  assert.deepEqual(mapSendgridEvents(null), []);
  assert.deepEqual(mapSendgridEvents([{ event: 'unsubscribe' }, { email: 'x@x.edu' }]), []); // missing email/event
});

// --- SendGrid signature (Ed25519) --------------------------------------------

test('SendGrid ECDSA-SHA256 signature verifies and rejects tampering', () => {
  // SendGrid signs with ECDSA over an EC P-256 key (official spec), not Ed25519.
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pubB64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const timestamp = '1700000000';
  const rawBody = Buffer.from(JSON.stringify([{ email: 'a@x.edu', event: 'unsubscribe' }]));
  const sig = nodeSign('sha256', Buffer.concat([Buffer.from(timestamp), rawBody]), privateKey).toString('base64');

  assert.equal(verifySendgridSignature(pubB64, rawBody, sig, timestamp), true);
  assert.equal(verifySendgridSignature(pubB64, Buffer.from('[]'), sig, timestamp), false);   // tampered body
  assert.equal(verifySendgridSignature(pubB64, rawBody, sig, '1700000001'), false);          // tampered timestamp
  assert.equal(verifySendgridSignature(pubB64, rawBody, undefined, timestamp), false);
  assert.equal(verifySendgridSignature('', rawBody, sig, timestamp), false);                 // no key
});
