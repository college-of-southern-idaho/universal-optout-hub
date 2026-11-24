import test from 'node:test';
import assert from 'node:assert/strict';
import { mapDecision } from '../src/services/consent-check.js';
import { hashApiKey, generateApiKey } from '../src/auth/apikeys.js';

// --- Decision table (ADR-0004 §3) — the compliance-critical logic ------------

test('opt-out and suppressed always suppress, in either mode', () => {
  for (const mode of ['blocklist', 'allowlist'] as const) {
    assert.deepEqual(mapDecision('opted_out', mode), { decision: 'suppress', advisory: false });
    assert.deepEqual(mapDecision('suppressed', mode), { decision: 'suppress', advisory: false });
  }
});

test('opted_in allows in either mode, no advisory', () => {
  for (const mode of ['blocklist', 'allowlist'] as const) {
    assert.deepEqual(mapDecision('opted_in', mode), { decision: 'allow', advisory: false });
  }
});

test('unknown → allow under blocklist (default), with advisory', () => {
  assert.deepEqual(mapDecision('unknown', 'blocklist'), { decision: 'allow', advisory: true });
});

test('unknown → suppress under allowlist (strict), with advisory', () => {
  assert.deepEqual(mapDecision('unknown', 'allowlist'), { decision: 'suppress', advisory: true });
});

test('a propagated suppression is never allowed — the cross-platform guarantee', () => {
  // suppressed = opt-out propagated from another platform; must block regardless of mode.
  assert.equal(mapDecision('suppressed', 'blocklist').decision, 'suppress');
  assert.equal(mapDecision('suppressed', 'allowlist').decision, 'suppress');
});

// --- API key hashing (ADR-0004 §2.3) -----------------------------------------

test('hashApiKey is deterministic and not the plaintext', () => {
  const k = 'oohk_example-token';
  assert.equal(hashApiKey(k), hashApiKey(k));
  assert.notEqual(hashApiKey(k), k);
  assert.match(hashApiKey(k), /^[0-9a-f]{64}$/); // sha256 hex
});

test('generateApiKey yields a prefixed key whose stored hash matches', () => {
  const { plaintext, hash, prefix } = generateApiKey();
  assert.ok(plaintext.startsWith('oohk_'));
  assert.equal(hash, hashApiKey(plaintext));
  assert.ok(plaintext.startsWith(prefix));
  assert.notEqual(generateApiKey().plaintext, generateApiKey().plaintext); // random
});
