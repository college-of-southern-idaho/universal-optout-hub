import test from 'node:test';
import assert from 'node:assert/strict';
import { skipUnlessDb, setup, reset, seedSystem } from './harness.js';
import { ingest } from '../../src/services/ingest.js';
import { checkConsent, reportConsent } from '../../src/services/consent-check.js';
import { pool } from '../../src/db.js';

const opts = await skipUnlessDb();
if (!('skip' in opts)) await setup();

test('checkConsent (blocklist): opted-out suppresses, unknown allows', opts, async () => {
  await reset();
  await seedSystem({ id: 'sender', channel: 'sms', category: 'marketing' });
  await ingest({ system_id: 'sender', identity_value: '+12085550130', direction: 'opt_out', source_detail: 'STOP' });

  const res = await checkConsent('sender', 'sms', ['+12085550130', '+12085550131'], 'blocklist', null);
  const byNorm = Object.fromEntries(res.map((r) => [r.normalized, r]));

  assert.equal(byNorm['+12085550130'].decision, 'suppress');   // known opt-out
  assert.equal(byNorm['+12085550130'].state, 'opted_out');
  assert.equal(byNorm['+12085550131'].decision, 'allow');      // unknown → blocklist sends
  assert.equal(byNorm['+12085550131'].advisory !== null, true);
});

test('checkConsent (allowlist): only an explicit opt-in is allowed; unknown withholds', opts, async () => {
  await reset();
  await seedSystem({ id: 'sender', channel: 'email', category: 'marketing' });
  await ingest({ system_id: 'sender', identity_value: 'grad@example.edu', direction: 'opt_in', evidence: { method: 'web form' } });

  const res = await checkConsent('sender', 'email', ['grad@example.edu', 'nobody@example.edu'], 'allowlist', null);
  const byNorm = Object.fromEntries(res.map((r) => [r.normalized, r]));

  assert.equal(byNorm['grad@example.edu'].decision, 'allow');
  assert.equal(byNorm['nobody@example.edu'].decision, 'suppress');  // unknown → allowlist withholds
});

test('checkConsent rejects a channel that does not match the system', opts, async () => {
  await reset();
  await seedSystem({ id: 'sms_sys', channel: 'sms', category: 'marketing' });
  await assert.rejects(() => checkConsent('sms_sys', 'email', ['x@example.edu'], 'blocklist', null), /channel/i);
  await assert.rejects(() => checkConsent('nope', 'sms', ['+12085550132'], 'blocklist', null), /unknown or archived/i);
});

test('a suppress check persists the FULL response as durable evidence', opts, async () => {
  await reset();
  await seedSystem({ id: 'sender', channel: 'sms', category: 'marketing' });
  await ingest({ system_id: 'sender', identity_value: '+12085550140', direction: 'opt_out', source_detail: 'STOP' });

  const [chk] = await checkConsent('sender', 'sms', ['+12085550140'], 'blocklist', null);
  assert.equal(chk.decision, 'suppress');

  // The audit row must capture decision + state AND the full returned message.
  const { rows } = await pool.query(
    `SELECT decision, state, reason, as_of, advisory, checked_at
       FROM consent_checks
      WHERE system_id = 'sender' AND identity_norm = '+12085550140' AND decision = 'suppress'`,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].decision, 'suppress');
  assert.equal(rows[0].state, 'opted_out');
  assert.equal(rows[0].reason, chk.reason);        // exact returned reason retained
  assert.ok(rows[0].as_of instanceof Date);        // opt-out effective time retained
  assert.ok(rows[0].checked_at instanceof Date);
});

test('reportConsent lets a sender feed an opt-out that then suppresses the check', opts, async () => {
  await reset();
  await seedSystem({ id: 'twilio_txn', channel: 'sms', category: 'marketing' });

  const r = await reportConsent('twilio_txn', { value: '+1 (208) 555-0133', direction: 'opt_out', source: 'inbound STOP' });
  assert.equal(r.ok, true);
  assert.equal(r.direction, 'opt_out');

  const [chk] = await checkConsent('twilio_txn', 'sms', ['+12085550133'], 'blocklist', null);
  assert.equal(chk.decision, 'suppress');
  assert.equal(chk.state, 'opted_out');
});
