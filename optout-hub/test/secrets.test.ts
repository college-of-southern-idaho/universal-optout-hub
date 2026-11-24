import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveKey, encryptSecretWith, decryptSecretWith, encryptSecret, decryptSecret,
} from '../src/core/secrets.js';

// Credential encryption (AES-256-GCM) + the key-rotation primitives.

test('encrypt/decrypt round-trips with the active key', () => {
  const blob = encryptSecret('SG.super-secret-token');
  assert.notEqual(blob, 'SG.super-secret-token');       // actually encrypted
  assert.equal(decryptSecret(blob), 'SG.super-secret-token');
});

test('each encryption uses a fresh IV, so ciphertext differs for the same input', () => {
  assert.notEqual(encryptSecret('same'), encryptSecret('same'));
});

test('a secret encrypted under one key does not decrypt under another', () => {
  const keyA = deriveKey('secret-A-secret-A');
  const keyB = deriveKey('secret-B-secret-B');
  const blob = encryptSecretWith(keyA, 'auth_token=abc');
  assert.equal(decryptSecretWith(keyA, blob), 'auth_token=abc');
  assert.throws(() => decryptSecretWith(keyB, blob)); // GCM auth tag rejects the wrong key
});

test('rotation: re-encrypting from the old key to the new key preserves the plaintext', () => {
  const oldKey = deriveKey('old-app-secret-xx');
  const newKey = deriveKey('new-app-secret-yy');
  const original = 'client_secret=rotate-me';

  const underOld = encryptSecretWith(oldKey, original);
  const plaintext = decryptSecretWith(oldKey, underOld);   // what the reencrypt tool does
  const underNew = encryptSecretWith(newKey, plaintext);

  assert.equal(decryptSecretWith(newKey, underNew), original);
  assert.throws(() => decryptSecretWith(oldKey, underNew)); // old key no longer works
});
