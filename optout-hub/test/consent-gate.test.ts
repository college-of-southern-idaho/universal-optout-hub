import test from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../examples/consent-gate/consent-gate.js';

// The sender's fail-closed contract (ADR-0004): only an explicit `allow` sends.

test('allow → send', () => {
  const d = decide({ identity: '+12084207280', decision: 'allow', reason: 'no suppression on record' }, '+12084207280');
  assert.equal(d.send, true);
});

test('suppress → withhold', () => {
  const d = decide({ identity: '+12084207280', decision: 'suppress', reason: 'propagated opt-out' }, '+12084207280');
  assert.equal(d.send, false);
  assert.match(d.reason, /propagated opt-out/);
});

test('error decision → fail closed (withhold)', () => {
  const d = decide({ identity: 'bad', decision: 'error', reason: 'unrecognized identity format' }, 'bad');
  assert.equal(d.send, false);
  assert.match(d.reason, /fail-closed/);
});

test('hub failure (null result) → fail closed (withhold)', () => {
  const d = decide(null, '+12084207280');
  assert.equal(d.send, false);
  assert.match(d.reason, /fail-closed/);
});

test('a missing/unknown decision value never sends', () => {
  // Defensive: an unexpected shape must not be treated as allow.
  const d = decide({ identity: 'x', decision: 'weird' as any }, 'x');
  assert.equal(d.send, false);
});
