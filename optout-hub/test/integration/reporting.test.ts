import test from 'node:test';
import assert from 'node:assert/strict';
import { skipUnlessDb, setup, reset, seedSystem } from './harness.js';
import { ingest } from '../../src/services/ingest.js';
import { lookupIdentity, searchAudit } from '../../src/services/reporting.js';
import { pool } from '../../src/db.js';

const opts = await skipUnlessDb();
if (!('skip' in opts)) await setup();

test('lookupIdentity assembles the cross-system packet after a cascaded opt-out', opts, async () => {
  await reset();
  await seedSystem({ id: 'mkt_a', channel: 'sms', category: 'marketing' });
  await seedSystem({ id: 'mkt_b', channel: 'sms', category: 'marketing' });
  await ingest({ system_id: 'mkt_a', identity_value: '+12085550140', direction: 'opt_out', source_detail: 'STOP' });

  const packet = await lookupIdentity('+1 (208) 555-0140');   // raw form normalizes to the same identity
  assert.ok(packet, 'expected a packet for a known identity');
  assert.equal(packet!.identity.value_normalized, '+12085550140');
  assert.deepEqual(packet!.reachability.currently_reachable, []);
  assert.deepEqual([...packet!.reachability.suppressed_or_opted_out].sort(), ['mkt_a', 'mkt_b']);

  // The automated (webhook) opt-out event is attributed to "System", not a user.
  const originEvent = packet!.events.find((e: any) => e.system_id === 'mkt_a');
  assert.ok(originEvent, 'expected an origin event');
  assert.equal(originEvent.actor, 'System');
  assert.equal(originEvent.direction, 'opt_out');
});

test('lookupIdentity returns null for an unknown or unnormalizable identity', opts, async () => {
  await reset();
  assert.equal(await lookupIdentity('+12085559999'), null);   // never seen
  assert.equal(await lookupIdentity('not-a-real-identity'), null);
});

test('searchAudit labels automated actions as "System" and filters by it', opts, async () => {
  await reset();
  await seedSystem({ id: 'mkt_a', channel: 'sms', category: 'marketing' });
  await seedSystem({ id: 'mkt_b', channel: 'sms', category: 'marketing' });
  // An automated opt-out ingest emits audit rows with a NULL / system:* actor.
  await ingest({ system_id: 'mkt_a', identity_value: '+12085550141', direction: 'opt_out', source_detail: 'STOP' });
  // A scheduler-style action carries the reserved system:* actor label.
  await pool.query(`INSERT INTO audit_log (actor, action, detail) VALUES ('system:scheduler','reconcile_run','{}')`);

  const all = await searchAudit({ limit: 100 });
  assert.ok(all.length > 0);
  assert.ok(all.every((r: any) => r.actor_label != null));
  const scheduler = all.find((r: any) => r.action === 'reconcile_run');
  assert.ok(scheduler, 'expected the scheduler audit row');
  assert.equal(scheduler.actor_label, 'System');   // system:* collapses to System

  const systemOnly = await searchAudit({ actor: 'System', limit: 100 });
  assert.ok(systemOnly.length > 0);
  assert.ok(systemOnly.every((r: any) => r.actor_label === 'System'));
});
