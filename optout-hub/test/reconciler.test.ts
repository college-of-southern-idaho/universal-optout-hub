import test from 'node:test';
import assert from 'node:assert/strict';
import { backfillTargets } from '../src/services/reconciler.js';

// backfillTargets is pure: (activeIds, statedSystems, sourceCategories,
// sourceChannels, categoryOf, channelOf, cascadeFn). cascadeFn bakes in the
// matrix + protected exclusion; channels keep an opt-out within its own channel.
const catFrom = (m: Record<string, string>) => (id: string): string => m[id] ?? 'marketing';
const chanFrom = (m: Record<string, string>) => (id: string): string => m[id] ?? 'sms';
const SMS = new Set(['sms']);

test('backfillTargets: a new same-category, same-channel system is backfilled', () => {
  const cat = catFrom({ a: 'marketing', b: 'marketing', c: 'marketing' });
  const chan = chanFrom({ a: 'sms', b: 'sms', c: 'sms' });
  const casc = (s: string, t: string) => s === 'marketing' && t === 'marketing';
  assert.deepEqual(
    backfillTargets(['a', 'b', 'c'], new Set(['a', 'b']), new Set(['marketing']), SMS, cat, chan, casc),
    ['c'],
  );
});

test('backfillTargets: a different-category system is NOT backfilled (matrix says no)', () => {
  const cat = catFrom({ a: 'marketing', c: 'transactional' });
  const chan = chanFrom({ a: 'sms', c: 'sms' });
  const casc = (s: string, t: string) => s === 'marketing' && t === 'marketing';
  assert.deepEqual(
    backfillTargets(['a', 'c'], new Set(['a']), new Set(['marketing']), SMS, cat, chan, casc),
    [],
  );
});

test('backfillTargets: an opt-out never crosses channels (sms source, email target)', () => {
  const cat = catFrom({ a: 'marketing', e: 'marketing' });
  const chan = chanFrom({ a: 'sms', e: 'email' });   // e is an EMAIL service
  const casc = () => true;                            // matrix would allow it
  assert.deepEqual(
    backfillTargets(['a', 'e'], new Set(['a']), new Set(['marketing']), SMS, cat, chan, casc),
    [],                                                // ...but the channel guard blocks it
  );
});

test('backfillTargets: transactional source cascades up to a marketing target (same channel)', () => {
  const cat = catFrom({ t: 'transactional', m: 'marketing' });
  const chan = chanFrom({ t: 'sms', m: 'sms' });
  const casc = (s: string, t: string) => s === 'transactional' && (t === 'transactional' || t === 'marketing');
  assert.deepEqual(
    backfillTargets(['t', 'm'], new Set(['t']), new Set(['transactional']), SMS, cat, chan, casc),
    ['m'],
  );
});

test('backfillTargets: a protected (emergency) target is never backfilled', () => {
  const cat = catFrom({ a: 'marketing', e: 'emergency' });
  const chan = chanFrom({ a: 'sms', e: 'sms' });
  const casc = (_s: string, t: string) => t !== 'emergency';   // protected excluded by cascadeFn
  assert.deepEqual(
    backfillTargets(['a', 'e'], new Set(['a']), new Set(['marketing', 'transactional']), SMS, cat, chan, casc),
    [],
  );
});

test('backfillTargets: nothing when there is no opt-out source category', () => {
  const cat = catFrom({});
  const chan = chanFrom({});
  const casc = () => true;
  assert.deepEqual(backfillTargets(['a', 'b'], new Set(['a']), new Set(), SMS, cat, chan, casc), []);
});

test('backfillTargets: skips systems that already have any state', () => {
  const cat = catFrom({});
  const chan = chanFrom({});
  const casc = () => true;
  assert.deepEqual(backfillTargets(['a', 'b'], new Set(['a', 'b']), new Set(['marketing']), SMS, cat, chan, casc), []);
});
