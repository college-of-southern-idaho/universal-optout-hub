import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../src/auth/passwords.js';
import { hasRole } from '../src/auth/users.js';

test('hash/verify roundtrip', async () => {
  const h = await hashPassword('correct horse battery');
  assert.ok(h.startsWith('scrypt$'));
  assert.equal(await verifyPassword('correct horse battery', h), true);
  assert.equal(await verifyPassword('wrong password!!', h), false);
});

test('two hashes of the same password differ (salted)', async () => {
  const a = await hashPassword('correct horse battery');
  const b = await hashPassword('correct horse battery');
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('correct horse battery', a), true);
  assert.equal(await verifyPassword('correct horse battery', b), true);
});

test('short passwords rejected', async () => {
  await assert.rejects(() => hashPassword('short'), /at least 10/);
});

test('malformed stored hashes verify false, never throw', async () => {
  assert.equal(await verifyPassword('whatever123', 'not-a-hash'), false);
  assert.equal(await verifyPassword('whatever123', 'bcrypt$x$y'), false);
});

test('hash format is self-describing (params embedded)', async () => {
  const h = await hashPassword('correct horse battery');
  const [, n, r, p] = h.split('$');
  assert.equal(Number(n), 2 ** 17);
  assert.equal(Number(r), 8);
  assert.equal(Number(p), 1);
});

test('role hierarchy: viewer < operator < approver < admin', () => {
  assert.equal(hasRole('admin', 'viewer'), true);
  assert.equal(hasRole('approver', 'operator'), true);
  assert.equal(hasRole('operator', 'approver'), false);
  assert.equal(hasRole('viewer', 'operator'), false);
  assert.equal(hasRole('operator', 'operator'), true);
});
