import test from 'node:test';
import assert from 'node:assert/strict';
import { SuppressionCache } from '../examples/consent-gate/suppression-cache.js';
import { decideFallback, defaultNormalize } from '../examples/consent-gate/consent-gate.js';

// Hub-synced suppression cache + fail-to-cache outage rule (ADR-0004 §2.4/§6).

test('a full feed sets the baseline suppression set and advances the cursor', () => {
  const c = new SuppressionCache();
  c.applyFeed({
    system: 's', as_of: '2026-07-30T00:00:00.000Z', full: true,
    entries: [
      { identity: '+12084207280', suppressed: true },
      { identity: '+12085550101', suppressed: true },
    ],
  });
  assert.equal(c.ready, true);
  assert.equal(c.size, 2);
  assert.equal(c.isSuppressed('+12084207280'), true);
  assert.equal(c.cursor, '2026-07-30T00:00:00.000Z');
});

test('a delta adds newly-suppressed and removes un-suppressed identities', () => {
  const c = new SuppressionCache();
  c.applyFeed({ system: 's', as_of: 't1', full: true, entries: [{ identity: 'a', suppressed: true }] });
  c.applyFeed({
    system: 's', as_of: 't2', full: false,
    entries: [
      { identity: 'b', suppressed: true },   // newly suppressed
      { identity: 'a', suppressed: false },  // re-opted-in → drop
    ],
  });
  assert.equal(c.isSuppressed('a'), false);
  assert.equal(c.isSuppressed('b'), true);
  assert.equal(c.cursor, 't2');
});

test('a full feed replaces the set; a delta does not', () => {
  const c = new SuppressionCache();
  c.applyFeed({ system: 's', as_of: 't1', full: true, entries: [{ identity: 'a', suppressed: true }] });
  // A later FULL baseline that omits `a` means `a` is no longer suppressed.
  c.applyFeed({ system: 's', as_of: 't2', full: true, entries: [{ identity: 'c', suppressed: true }] });
  assert.equal(c.isSuppressed('a'), false);
  assert.equal(c.isSuppressed('c'), true);
  assert.equal(c.size, 1);
});

// --- fail-to-cache decision ---------------------------------------------------

test('before any sync, an outage fails closed (no last-known list)', () => {
  const c = new SuppressionCache();
  const d = decideFallback(c, '+12084207280', defaultNormalize);
  assert.equal(d.send, false);
  assert.match(d.reason, /no cached suppression list/);
});

test('no cache configured at all → fail closed', () => {
  const d = decideFallback(undefined, '+12084207280', defaultNormalize);
  assert.equal(d.send, false);
  assert.match(d.reason, /fail-closed/);
});

test('outage with a ready cache: suppressed number is withheld', () => {
  const c = new SuppressionCache();
  c.applyFeed({ system: 's', as_of: 't', full: true, entries: [{ identity: '+12084207280', suppressed: true }] });
  const d = decideFallback(c, '+1 (208) 420-7280', defaultNormalize); // messy input, normalizes to match
  assert.equal(d.send, false);
  assert.match(d.reason, /last-known/);
});

test('outage with a ready cache: a number NOT on the list is sent (degrade to last-known)', () => {
  const c = new SuppressionCache();
  c.applyFeed({ system: 's', as_of: 't', full: true, entries: [{ identity: '+12084207280', suppressed: true }] });
  const d = decideFallback(c, '+12085550999', defaultNormalize);
  assert.equal(d.send, true);
  assert.match(d.reason, /last-known/);
});

// --- default normalization ----------------------------------------------------

test('defaultNormalize lower-cases email and strips phone punctuation', () => {
  assert.equal(defaultNormalize('  Person@Example.EDU '), 'person@example.edu');
  assert.equal(defaultNormalize('+1 (208) 420-7280'), '+12084207280');
});
