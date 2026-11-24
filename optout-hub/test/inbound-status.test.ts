import test from 'node:test';
import assert from 'node:assert/strict';
import { deliveryMode } from '../src/services/reporting.js';

test('poll-capable systems are poll-delivery regardless of type', () => {
  assert.equal(deliveryMode(true, 'constant_contact'), 'poll');
  assert.equal(deliveryMode(true, 'twilio'), 'poll'); // pollable wins over webhook type
});

test('known webhook adapter types are webhook-delivery when not pollable', () => {
  assert.equal(deliveryMode(false, 'twilio'), 'webhook');
  assert.equal(deliveryMode(false, 'sendgrid'), 'webhook');
  assert.equal(deliveryMode(false, 'telesign'), 'webhook');
});

test('everything else is none (outbound- or reconciliation-only)', () => {
  assert.equal(deliveryMode(false, 'modern_campus_message'), 'none');
  assert.equal(deliveryMode(false, 'mock'), 'none');
  assert.equal(deliveryMode(false, ''), 'none');
});
