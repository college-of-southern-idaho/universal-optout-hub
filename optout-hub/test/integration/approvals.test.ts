import test from 'node:test';
import assert from 'node:assert/strict';
import { skipUnlessDb, setup, reset, seedSystem, statesFor } from './harness.js';
import { ingest } from '../../src/services/ingest.js';
import { createOrCoalesceReview, decide } from '../../src/services/approvals.js';
import { applyConfig } from '../../src/core/policy.js';
import { normalizeIdentity } from '../../src/core/normalize.js';
import { pool } from '../../src/db.js';

const opts = await skipUnlessDb();
if (!('skip' in opts)) await setup();

/** Resolve the numeric identity id + newest event id for a normalized value. */
async function idAndLatestEvent(idv: string): Promise<{ identityId: number; eventId: number }> {
  const r = await pool.query(
    `SELECT i.id AS identity_id,
            (SELECT e.id FROM consent_events e WHERE e.identity_id = i.id ORDER BY e.id DESC LIMIT 1) AS event_id
       FROM identities i WHERE i.value_normalized = $1`,
    [idv],
  );
  return { identityId: r.rows[0].identity_id, eventId: r.rows[0].event_id };
}

async function pendingReview(identityId: number): Promise<{ id: number; version: number }> {
  const r = await pool.query(
    `SELECT id, version FROM approval_requests WHERE identity_id=$1 AND status='pending'`,
    [identityId],
  );
  return r.rows[0];
}

test('approve → opt-in propagates to the selected target and confirms via echo', opts, async () => {
  await reset();
  await seedSystem({ id: 'origin', channel: 'sms', category: 'marketing' });
  await seedSystem({ id: 'target', channel: 'sms', category: 'marketing', can_write_optin: true });

  const idv = normalizeIdentity('+12085550120')!.normalized;
  await ingest({ system_id: 'origin', identity_value: '+12085550120', direction: 'opt_in', evidence: { method: 'web form' } });

  const { identityId, eventId } = await idAndLatestEvent(idv);
  await createOrCoalesceReview(identityId, 'sms', eventId, 'origin');
  const req = await pendingReview(identityId);

  await decide({
    requestId: req.id, version: req.version, outcome: 'approved',
    selectedTargets: ['target'], attestationText: 'reviewed the enrollment evidence', decidedBy: 'alice',
  });

  const s = await statesFor(idv);
  assert.equal(s['target']?.state, 'opted_in');
  assert.equal(s['target']?.provenance, 'derived');   // propagated by an approval, not first-party
  const hw = await pool.query(
    `SELECT confirmed_at FROM hub_writes WHERE system_id='target' AND direction='opt_in'`,
  );
  assert.equal(hw.rows.length, 1);
  assert.notEqual(hw.rows[0].confirmed_at, null);      // mock echoed → convergence confirmed
});

test('separation of duties: the initiating operator cannot approve their own review', opts, async () => {
  await reset();
  await seedSystem({ id: 'origin', channel: 'sms', category: 'marketing' });
  await seedSystem({ id: 'target', channel: 'sms', category: 'marketing' });
  await applyConfig({ initiatorCannotApprove: true }, 'test-setup');

  const u = await pool.query(
    `INSERT INTO users (username, display_name, role) VALUES
       ('bob','Bob','approver'),('carol','Carol','approver') RETURNING id, username`,
  );
  const userId: number = u.rows.find((r) => r.username === 'bob').id;
  const carolId: number = u.rows.find((r) => r.username === 'carol').id;

  const idv = normalizeIdentity('+12085550121')!.normalized;
  await ingest({ system_id: 'origin', identity_value: '+12085550121', direction: 'opt_in', evidence: { method: 'web form' } });
  const { identityId, eventId } = await idAndLatestEvent(idv);
  await createOrCoalesceReview(identityId, 'sms', eventId, 'origin', userId);
  const req = await pendingReview(identityId);

  await assert.rejects(
    () => decide({
      requestId: req.id, version: req.version, outcome: 'approved',
      selectedTargets: ['target'], attestationText: 'I reviewed it', decidedBy: 'bob', decidedByUserId: userId,
    }),
    /separation of duties/i,
  );

  // A different approver may still decide it.
  const req2 = await pendingReview(identityId);
  await decide({
    requestId: req2.id, version: req2.version, outcome: 'approved',
    selectedTargets: [], attestationText: 'reviewed by a second approver', decidedBy: 'carol', decidedByUserId: carolId,
  });
  const after = await pool.query(`SELECT status FROM approval_requests WHERE id=$1`, [req.id]);
  assert.equal(after.rows[0].status, 'approved');
});

test('approval never overrides an EXPLICIT opt-out on a target', opts, async () => {
  await reset();
  await seedSystem({ id: 'origin', channel: 'sms', category: 'marketing' });
  await seedSystem({ id: 'target', channel: 'sms', category: 'marketing' });

  const idv = normalizeIdentity('+12085550122')!.normalized;
  // Target has a first-party explicit opt-out on record.
  await ingest({ system_id: 'target', identity_value: '+12085550122', direction: 'opt_out', source_detail: 'STOP' });
  // A later opt-in on origin queues a review that lists target.
  await ingest({ system_id: 'origin', identity_value: '+12085550122', direction: 'opt_in', evidence: { method: 'web form' } });

  const { identityId, eventId } = await idAndLatestEvent(idv);
  await createOrCoalesceReview(identityId, 'sms', eventId, 'origin');
  const req = await pendingReview(identityId);

  await decide({
    requestId: req.id, version: req.version, outcome: 'approved',
    selectedTargets: ['target'], attestationText: 'approving despite the opt-out', decidedBy: 'alice',
  });

  const s = await statesFor(idv);
  assert.equal(s['target']?.state, 'opted_out');        // unchanged — explicit opt-out wins
  assert.equal(s['target']?.provenance, 'explicit');
  const outcome = await pool.query(
    `SELECT outcome FROM approval_targets WHERE request_id=$1 AND system_id='target'`, [req.id],
  );
  assert.equal(outcome.rows[0].outcome, 'skipped_explicit_optout');
});
