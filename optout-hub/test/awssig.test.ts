import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveSigningKey, signAwsV4, amzDateNow } from '../src/adapters/awssig.js';

// AWS's published example for "Deriving the signing key"
// (secret wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY, 20150830, us-east-1, iam).
test('deriveSigningKey matches the AWS documented vector', () => {
  const key = deriveSigningKey('wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20150830', 'us-east-1', 'iam');
  assert.equal(key.toString('hex'), 'c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9');
});

const BASE = {
  method: 'POST', host: 'sns.us-west-2.amazonaws.com', region: 'us-west-2', service: 'sns',
  accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  amzDate: '20260828T170000Z',
};

test('signAwsV4 signs content-type when provided (POST with a body)', () => {
  const r = signAwsV4({
    ...BASE, body: 'Action=ListPhoneNumbersOptedOut&Version=2010-03-31',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(r.signedHeaders, 'content-type;host;x-amz-date'); // sorted
  assert.match(r.signature, /^[0-9a-f]{64}$/);
  assert.ok(r.authorization.startsWith(
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260828/us-west-2/sns/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=',
  ));
});

test('signAwsV4 signs only host + x-amz-date when no extra headers (GET/DELETE)', () => {
  const r = signAwsV4({ ...BASE, method: 'GET', body: '' });
  assert.equal(r.signedHeaders, 'host;x-amz-date');
});

test('signature is deterministic and body-sensitive', () => {
  const a = signAwsV4({ ...BASE, body: 'Action=A' }).signature;
  const b = signAwsV4({ ...BASE, body: 'Action=A' }).signature;
  const c = signAwsV4({ ...BASE, body: 'Action=B' }).signature;
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('amzDateNow formats YYYYMMDDTHHMMSSZ', () => {
  assert.equal(amzDateNow(new Date('2026-08-28T17:05:09.123Z')), '20260828T170509Z');
});
