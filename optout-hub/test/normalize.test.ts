import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, normalizeEmail, normalizeIdentity } from '../src/core/normalize.js';

// Identity normalization (DESIGN §4), now backed by libphonenumber metadata.

test('US numbers normalize to E.164 from any common formatting', () => {
  for (const raw of ['+12084207280', '2084207280', '12084207280', '(208) 420-7280', '208-420-7280', '+1 208 420 7280']) {
    assert.equal(normalizePhone(raw), '+12084207280', `for ${raw}`);
  }
});

test('international numbers normalize to their own E.164 (not forced to +1)', () => {
  assert.equal(normalizePhone('+44 7911 123456'), '+447911123456'); // UK mobile
  assert.equal(normalizePhone('+61 2 9374 4000'), '+61293744000');  // AU
});

test('structurally-implausible input is rejected', () => {
  for (const raw of ['not-a-number', '555', '123', '', '+', 'abcdefghij']) {
    assert.equal(normalizePhone(raw), null, `for ${JSON.stringify(raw)}`);
  }
});

test('fictional 555 numbers are accepted (possible length), so opt-outs are never dropped', () => {
  // 555-line numbers are not "valid" (unassigned range) but are structurally
  // possible; a consent hub records them rather than rejecting a suppression.
  assert.equal(normalizePhone('+15555555555'), '+15555555555');
});

test('email is lowercased; plus-addressing stays distinct', () => {
  assert.equal(normalizeEmail('  Person@Example.EDU '), 'person@example.edu');
  assert.equal(normalizeEmail('a+promo@example.com'), 'a+promo@example.com');
  assert.equal(normalizeEmail('not-an-email'), null);
});

test('normalizeIdentity routes by shape and preserves raw', () => {
  assert.deepEqual(normalizeIdentity('(208) 420-7280'), { kind: 'phone', normalized: '+12084207280', raw: '(208) 420-7280' });
  assert.deepEqual(normalizeIdentity('Person@Example.edu'), { kind: 'email', normalized: 'person@example.edu', raw: 'Person@Example.edu' });
  assert.equal(normalizeIdentity('garbage'), null);
});
