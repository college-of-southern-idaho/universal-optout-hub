import test from 'node:test';
import assert from 'node:assert/strict';
import { twilioInboundWebhookParams, twilioConsentPayload, twilioAuthPair } from '../src/adapters/twilio.js';

test('twilioAuthPair prefers an API Key over the Auth Token', () => {
  // API key present → use it.
  assert.deepEqual(
    twilioAuthPair({ account_sid: 'AC1', auth_token: 'tok', api_key_sid: 'SK9', api_key_secret: 'sek' }),
    { user: 'SK9', pass: 'sek' },
  );
  // No API key → fall back to Account SID + Auth Token.
  assert.deepEqual(twilioAuthPair({ account_sid: 'AC1', auth_token: 'tok' }), { user: 'AC1', pass: 'tok' });
  // Incomplete API key (secret missing) → fall back to the token.
  assert.deepEqual(twilioAuthPair({ account_sid: 'AC1', auth_token: 'tok', api_key_sid: 'SK9' }), { user: 'AC1', pass: 'tok' });
  // Nothing usable.
  assert.equal(twilioAuthPair({ account_sid: 'AC1' }), null);
  assert.equal(twilioAuthPair({}), null);
});

test('consent payload maps an opt-out to a Consent API bulk item', () => {
  const p = twilioConsentPayload('+12085550142', 'opt_out', 'MG123', 'sok-abc');
  const item = p.Items[0];
  assert.equal(item.contact_id, '+12085550142');
  assert.equal(item.sender_id, 'MG123');
  assert.equal(item.status, 'opt-out');
  assert.equal(item.source, 'opt-out-message');
  assert.match(item.correlation_id, /^[0-9a-f]{32}$/); // 32-char id derived from sync key
});

test('consent payload maps an opt-in with the opt-in status/source', () => {
  const item = twilioConsentPayload('+12085550142', 'opt_in', 'MG123', 'sok-xyz').Items[0];
  assert.equal(item.status, 'opt-in');
  assert.equal(item.source, 'opt-in-message');
});

test('correlation_id is deterministic per sync key (traceable, stable on retry)', () => {
  const a = twilioConsentPayload('+1', 'opt_out', 'MG1', 'same-key').Items[0].correlation_id;
  const b = twilioConsentPayload('+1', 'opt_out', 'MG1', 'same-key').Items[0].correlation_id;
  const c = twilioConsentPayload('+1', 'opt_out', 'MG1', 'other-key').Items[0].correlation_id;
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('builds the Messaging Service inbound-webhook update params', () => {
  const p = twilioInboundWebhookParams('https://hub.example.edu/api/webhooks/twilio/twilio_csi');
  assert.equal(p.get('InboundRequestUrl'), 'https://hub.example.edu/api/webhooks/twilio/twilio_csi');
  assert.equal(p.get('InboundMethod'), 'POST');
  // Service-level webhook must win over any per-number webhook.
  assert.equal(p.get('UseInboundWebhookOnNumber'), 'false');
});

test('url-encodes the webhook URL in the form body', () => {
  const body = twilioInboundWebhookParams('https://h.edu/api/webhooks/twilio/a b').toString();
  assert.match(body, /InboundRequestUrl=https%3A%2F%2Fh.edu%2Fapi%2Fwebhooks%2Ftwilio%2Fa\+b/);
});
