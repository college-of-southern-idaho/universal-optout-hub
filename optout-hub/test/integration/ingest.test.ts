import test from 'node:test';
import assert from 'node:assert/strict';
import { skipUnlessDb, setup, reset, seedSystem, statesFor } from './harness.js';
import { ingest } from '../../src/services/ingest.js';
import { reconcile } from '../../src/services/reconciler.js';
import { normalizeIdentity } from '../../src/core/normalize.js';

const opts = await skipUnlessDb();
if (!('skip' in opts)) await setup();

test('opt-out records opted_out and cascades within the same category + channel', opts, async () => {
  await reset();
  await seedSystem({ id: 'mkt_a', channel: 'sms', category: 'marketing' });
  await seedSystem({ id: 'mkt_b', channel: 'sms', category: 'marketing' });
  await seedSystem({ id: 'txn', channel: 'sms', category: 'transactional' });
  await seedSystem({ id: 'mkt_email', channel: 'email', category: 'marketing' });

  const idv = normalizeIdentity('+12085550111')!.normalized;
  await ingest({ system_id: 'mkt_a', identity_value: '+12085550111', direction: 'opt_out', source_detail: 'STOP' });

  const s = await statesFor(idv);
  assert.equal(s['mkt_a']?.state, 'opted_out');   // origin: explicit
  assert.equal(s['mkt_a']?.provenance, 'explicit');
  assert.equal(s['mkt_b']?.state, 'suppressed');  // same category + channel → cascaded
  assert.equal(s['mkt_b']?.provenance, 'derived');
  assert.equal(s['txn'], undefined);              // marketing does NOT cascade to transactional
  assert.equal(s['mkt_email'], undefined);        // channel-scoped: a phone opt-out never hits email
});

test('a protected (emergency) target is never suppressed by a cascade', opts, async () => {
  await reset();
  await seedSystem({ id: 'mkt', channel: 'sms', category: 'marketing' });
  await seedSystem({ id: 'safety', channel: 'sms', category: 'emergency' });
  // allow marketing -> emergency in the matrix; the engine must STILL refuse it
  const { pool } = await import('../../src/db.js');
  await pool.query(`INSERT INTO consent_category_cascade (source,target) VALUES ('marketing','emergency') ON CONFLICT DO NOTHING`);
  const { hydrateCategories } = await import('../../src/services/categories.js');
  await hydrateCategories();

  const idv = normalizeIdentity('+12085550113')!.normalized;
  await ingest({ system_id: 'mkt', identity_value: '+12085550113', direction: 'opt_out', source_detail: 'STOP' });

  const s = await statesFor(idv);
  assert.equal(s['mkt']?.state, 'opted_out');
  assert.equal(s['safety'], undefined);           // emergency is protected — never suppressed
});

test('backfill: a system added AFTER an opt-out is suppressed by the reconciler', opts, async () => {
  await reset();
  await seedSystem({ id: 'm1', channel: 'sms', category: 'marketing' });
  const idv = normalizeIdentity('+12085550112')!.normalized;
  await ingest({ system_id: 'm1', identity_value: '+12085550112', direction: 'opt_out', source_detail: 'STOP' });

  await seedSystem({ id: 'm2', channel: 'sms', category: 'marketing' });   // added after the opt-out
  await reconcile();

  const s = await statesFor(idv);
  assert.equal(s['m2']?.state, 'suppressed');
  assert.equal(s['m2']?.provenance, 'derived');
});

test('a cascaded write is confirmed via the platform echo, and a replayed echo is not re-recorded', opts, async () => {
  await reset();
  await seedSystem({ id: 'a', channel: 'sms', category: 'marketing' });
  await seedSystem({ id: 'b', channel: 'sms', category: 'marketing' });   // writable mock → echoes synchronously
  const { pool } = await import('../../src/db.js');
  const idv = normalizeIdentity('+12085550114')!.normalized;
  await ingest({ system_id: 'a', identity_value: '+12085550114', direction: 'opt_out', source_detail: 'STOP' });

  // The derived write to b round-trips through the mock's echo → the hub_write is confirmed.
  const hw = await pool.query(`SELECT sync_origin_key, confirmed_at FROM hub_writes WHERE system_id='b'`);
  assert.equal(hw.rows.length, 1);
  assert.notEqual(hw.rows[0].confirmed_at, null);

  // Replaying that same write as an inbound event is recognized as our own echo — no duplicate consumer event.
  const before = await pool.query(
    `SELECT count(*)::int n FROM consent_events e JOIN identities i ON i.id=e.identity_id
      WHERE i.value_normalized=$1 AND e.system_id='b'`, [idv]);
  await ingest({
    system_id: 'b', identity_value: '+12085550114', direction: 'opt_out',
    sync_origin_key: hw.rows[0].sync_origin_key, source_detail: 'replayed echo',
  });
  const after = await pool.query(
    `SELECT count(*)::int n FROM consent_events e JOIN identities i ON i.id=e.identity_id
      WHERE i.value_normalized=$1 AND e.system_id='b'`, [idv]);
  assert.equal(after.rows[0].n, before.rows[0].n);   // no new consumer event recorded
});

test('test mode (enableOutboundWrites=off): opt-out is recorded internally but never pushed to the platform', opts, async () => {
  await reset();
  await seedSystem({ id: 'a', channel: 'sms', category: 'marketing' });
  await seedSystem({ id: 'b', channel: 'sms', category: 'marketing' });   // writable mock
  const { pool } = await import('../../src/db.js');
  const { policy } = await import('../../src/core/policy.js');
  const idv = normalizeIdentity('+12085550160')!.normalized;

  policy.enableOutboundWrites = false;   // engage test mode
  try {
    await ingest({ system_id: 'a', identity_value: '+12085550160', direction: 'opt_out', source_detail: 'STOP' });

    // Internal state IS recorded: origin explicit, target cascaded — projection unchanged.
    const s = await statesFor(idv);
    assert.equal(s['a']?.state, 'opted_out');
    assert.equal(s['b']?.state, 'suppressed');
    assert.equal(s['b']?.provenance, 'derived');

    // But NOTHING was pushed to the platform: no hub_write and no platform record for b.
    const hw = await pool.query(`SELECT 1 FROM hub_writes WHERE system_id='b'`);
    assert.equal(hw.rows.length, 0);
    const pr = await pool.query(`SELECT 1 FROM platform_records WHERE system_id='b'`);
    assert.equal(pr.rows.length, 0);
  } finally {
    policy.enableOutboundWrites = true;   // restore (reset() won't, since it's not in app_config)
  }
});
