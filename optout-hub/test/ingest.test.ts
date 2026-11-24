import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldQueueReview } from '../src/services/ingest.js';

const optOutExplicit = { state: 'opted_out', provenance: 'explicit' };
const suppressed = { state: 'suppressed', provenance: 'derived' };
const optInElsewhere = { state: 'opted_in', provenance: 'explicit' };

test('shouldQueueReview: never trigger is always false', () => {
  assert.equal(shouldQueueReview('never', [optOutExplicit]), false);
  assert.equal(shouldQueueReview('never', []), false);
});

test('shouldQueueReview: any_state_elsewhere queues whenever the identity is known elsewhere', () => {
  assert.equal(shouldQueueReview('any_state_elsewhere', [optInElsewhere]), true);
  assert.equal(shouldQueueReview('any_state_elsewhere', [optOutExplicit]), true);
  assert.equal(shouldQueueReview('any_state_elsewhere', []), false);
});

test('shouldQueueReview: explicit_optout_elsewhere queues only on an explicit opt-out or suppression', () => {
  assert.equal(shouldQueueReview('explicit_optout_elsewhere', [optOutExplicit]), true);
  assert.equal(shouldQueueReview('explicit_optout_elsewhere', [suppressed]), true);
  assert.equal(shouldQueueReview('explicit_optout_elsewhere', [optInElsewhere]), false); // no conflict
  assert.equal(shouldQueueReview('explicit_optout_elsewhere', [{ state: 'opted_out', provenance: 'derived' }]), false);
  assert.equal(shouldQueueReview('explicit_optout_elsewhere', []), false);
});
