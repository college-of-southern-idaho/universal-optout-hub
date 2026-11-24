import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isPreselected, violatesSeparationOfDuties, skipsExplicitOptOut, attestationMissing,
} from '../src/services/approvals.js';

test('isPreselected: same-channel only, and only when policy is on', () => {
  assert.equal(isPreselected(true, 'sms', 'sms'), true);
  assert.equal(isPreselected(true, 'email', 'sms'), false);   // different channel
  assert.equal(isPreselected(false, 'sms', 'sms'), false);    // policy off
});

test('violatesSeparationOfDuties: only when on AND same user decides their own review', () => {
  assert.equal(violatesSeparationOfDuties(true, 7, 7), true);      // initiator == decider
  assert.equal(violatesSeparationOfDuties(true, 7, 9), false);     // different people
  assert.equal(violatesSeparationOfDuties(false, 7, 7), false);    // policy off
  assert.equal(violatesSeparationOfDuties(true, null, 7), false);  // no recorded initiator
  assert.equal(violatesSeparationOfDuties(true, 7, null), false);  // no authenticated decider
  assert.equal(violatesSeparationOfDuties(true, 7, undefined), false);
});

test('skipsExplicitOptOut: an EXPLICIT opt-out is never overridden by an approval', () => {
  assert.equal(skipsExplicitOptOut('opted_out', 'explicit'), true);
  assert.equal(skipsExplicitOptOut('opted_out', 'derived'), false);   // derived suppression can be re-opened
  assert.equal(skipsExplicitOptOut('suppressed', 'explicit'), false); // only opted_out+explicit blocks
  assert.equal(skipsExplicitOptOut('opted_in', 'explicit'), false);
  assert.equal(skipsExplicitOptOut(undefined, undefined), false);
});

test('attestationMissing: approvals require a non-empty attestation; denials do not', () => {
  assert.equal(attestationMissing('approved', ''), true);
  assert.equal(attestationMissing('approved', '   '), true);       // whitespace only
  assert.equal(attestationMissing('approved', undefined), true);
  assert.equal(attestationMissing('approved', 'I reviewed the evidence.'), false);
  assert.equal(attestationMissing('denied', ''), false);            // denial needs no attestation
});
