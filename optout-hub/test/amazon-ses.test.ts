import test from 'node:test';
import assert from 'node:assert/strict';
import { sesError } from '../src/adapters/amazon_ses.js';

test('sesError reads the SESv2 JSON error message', () => {
  assert.equal(sesError('{"message":"The request signature is invalid"}'), 'The request signature is invalid');
  assert.equal(sesError('{"Message":"Address not found"}'), 'Address not found');
});

test('sesError returns null for non-JSON or messageless bodies', () => {
  assert.equal(sesError(''), null);
  assert.equal(sesError('<html>oops</html>'), null);
  assert.equal(sesError('{"other":"x"}'), null);
});
