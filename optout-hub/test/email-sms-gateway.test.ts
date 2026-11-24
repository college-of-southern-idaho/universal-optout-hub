import test from 'node:test';
import assert from 'node:assert/strict';
import { gatewayAddress } from '../examples/email-sms-gateway-sender/send.js';

// Carrier email-to-SMS gateway addressing (consent classification stays SMS).

test('builds <10-digit>@carrier, dropping a leading US country code', () => {
  assert.equal(gatewayAddress('+12084207280', 'vtext.com'), '2084207280@vtext.com');
  assert.equal(gatewayAddress('2084207280', 'txt.att.net'), '2084207280@txt.att.net');
});

test('strips punctuation from the number', () => {
  assert.equal(gatewayAddress('+1 (208) 420-7280', 'vtext.com'), '2084207280@vtext.com');
});
