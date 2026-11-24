import test from 'node:test';
import assert from 'node:assert/strict';
import { acsContentHash, acsSign, rfc1123Now, parseAcsConnectionString } from '../src/adapters/azuresig.js';
import { acsError } from '../src/adapters/azure_communication.js';

test('acsContentHash is base64(SHA-256(body))', () => {
  // Known vectors: SHA-256 of '' and 'hello'.
  assert.equal(acsContentHash(''), '47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=');
  assert.equal(acsContentHash('hello'), 'LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=');
});

const BASE = {
  method: 'POST', pathAndQuery: '/sms/optouts:check?api-version=2026-01-23',
  host: 'my-resource.communication.azure.com',
  accessKey: Buffer.from('super-secret-key').toString('base64'),
  date: 'Thu, 28 Aug 2026 17:00:00 GMT',
};

test('acsSign yields the HMAC-SHA256 Authorization header + content hash', () => {
  const r = acsSign({ ...BASE, body: '{"from":"+1800","recipients":[{"to":"+1555"}]}' });
  assert.ok(r.authorization.startsWith('HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature='));
  assert.match(r.contentHash, /^[A-Za-z0-9+/]+=*$/); // base64
});

test('signature is deterministic and body-sensitive', () => {
  const a = acsSign({ ...BASE, body: '{"a":1}' }).authorization;
  const b = acsSign({ ...BASE, body: '{"a":1}' }).authorization;
  const c = acsSign({ ...BASE, body: '{"a":2}' }).authorization;
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('rfc1123Now formats an RFC1123 GMT date', () => {
  assert.equal(rfc1123Now(new Date('2026-08-28T17:00:00Z')), 'Fri, 28 Aug 2026 17:00:00 GMT');
});

test('parseAcsConnectionString extracts endpoint (trimmed) and access key', () => {
  const p = parseAcsConnectionString('endpoint=https://res.communication.azure.com/;accesskey=YWJjZA==');
  assert.deepEqual(p, { endpoint: 'https://res.communication.azure.com', accessKey: 'YWJjZA==' });
  assert.equal(parseAcsConnectionString('accesskey=only'), null);   // missing endpoint
  assert.equal(parseAcsConnectionString('garbage'), null);
});

test('acsError reads the ACS { error: { code, message } } shape', () => {
  assert.equal(acsError({ error: { code: 'Denied', message: 'hash differs' } }), 'Denied: hash differs');
  assert.equal(acsError({ value: [] }), null);
});
