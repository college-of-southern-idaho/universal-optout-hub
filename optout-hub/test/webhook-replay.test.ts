import test from 'node:test';
import assert from 'node:assert/strict';
import {
  withinClockSkew, mapTwilioInbound, mapSendgridEvents, mapTelesignInbound,
} from '../src/services/webhooks.js';

// Replay defense: timestamp freshness + per-event ids for de-duplication.

test('withinClockSkew accepts fresh timestamps and rejects stale/future ones', () => {
  const now = 1_000_000_000_000;
  assert.equal(withinClockSkew(now, now, 300), true);
  assert.equal(withinClockSkew(now - 299_000, now, 300), true);   // 299s old, within 300
  assert.equal(withinClockSkew(now - 301_000, now, 300), false);  // 301s old, stale
  assert.equal(withinClockSkew(now + 301_000, now, 300), false);  // 301s in the future
});

test('withinClockSkew: tolerance <= 0 disables the check; NaN is rejected', () => {
  assert.equal(withinClockSkew(0, 9_999_999_999_999, 0), true);   // disabled → always ok
  assert.equal(withinClockSkew(NaN, 1000, 300), false);           // unparseable timestamp
});

test('Twilio events carry the MessageSid as the dedup id', () => {
  const e = mapTwilioInbound({ From: '+12085550142', OptOutType: 'STOP', MessageSid: 'SM123' });
  assert.equal(e?.eventId, 'SM123');
  // Falls back to SmsSid when MessageSid is absent.
  const e2 = mapTwilioInbound({ From: '+12085550142', Body: 'stop', SmsSid: 'SS9' });
  assert.equal(e2?.eventId, 'SS9');
});

test('SendGrid events carry sg_event_id per event', () => {
  const events = mapSendgridEvents([
    { email: 'a@example.com', event: 'unsubscribe', timestamp: 1, sg_event_id: 'evt_a' },
    { email: 'b@example.com', event: 'group_resubscribe', timestamp: 2, sg_event_id: 'evt_b' },
    { email: 'c@example.com', event: 'open', sg_event_id: 'evt_c' }, // not consent → dropped
  ]);
  assert.deepEqual(events.map((e) => e.eventId), ['evt_a', 'evt_b']);
});

test('Telesign events carry reference_id as the dedup id', () => {
  const e = mapTelesignInbound({
    reference_id: 'REF-1', submit_timestamp: '2026-08-20T14:00:00Z',
    user_response: { phone_number: '12085550142', action: 'stop', keyword: 'stop' },
  });
  assert.equal(e?.eventId, 'REF-1');
});
