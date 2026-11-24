import { pool } from '../src/db.js';
import { loadAdapters, getAdapter } from '../src/adapters/registry.js';
import { ingest, resolveIdentity } from '../src/services/ingest.js';
import { getStates } from '../src/services/projection.js';
import { decide } from '../src/services/approvals.js';
import { reconcile } from '../src/services/reconciler.js';
import { syncTopology, annotateCode, getTopology } from '../src/services/topology.js';
import { topologyAttributionReport } from '../src/services/reporting.js';
import { ensureDemoSystems } from './fixtures.js';

/**
 * End-to-end walkthrough of the scenarios from the design discussion.
 * Run after `npm run seed`. Re-runnable: clears prior demo data first.
 */

const PHONE = '+12085550142';

function h(title: string): void {
  console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`);
}

async function printStates(label: string): Promise<void> {
  const id = await resolveIdentity(PHONE);
  const states = await getStates(id.id);
  console.log(`\n  ${label}`);
  for (const s of states) {
    console.log(`    ${s.system_id.padEnd(18)} ${s.state.padEnd(10)} (${s.provenance ?? '—'})`);
  }
}

async function consumer(systemId: string, direction: 'opt_in' | 'opt_out', detail: string, opts: {
  occurred_at?: Date; evidence?: { method: string; consent_language?: string };
  phone?: string; receiving_code?: string;
} = {}): Promise<any> {
  const phone = opts.phone ?? PHONE;
  // The consumer acts on the platform first; the platform then emits the event.
  await getAdapter(systemId).consumerAction(phone, direction);
  return ingest({
    system_id: systemId,
    identity_value: phone,
    direction,
    source_detail: detail,
    occurred_at: opts.occurred_at,
    evidence: opts.evidence,
    receiving_code: opts.receiving_code,
  });
}

async function reset(): Promise<void> {
  await pool.query(`TRUNCATE consent_events, consent_states, evidence, platform_records,
    hub_writes, approval_request_events, approval_targets, approval_requests,
    reconcile_alerts, audit_log, identities,
    topology_nodes, code_annotations, platform_topology RESTART IDENTITY CASCADE`);
}

// Simulated service-side topology the demo "discovers" through the adapter.
const DEMO_TOPOLOGY = [
  { system_id: 'twilio_custom', kind: 'pool', external_ref: 'pool_admissions', label: 'Admissions', parent_ref: null },
  { system_id: 'twilio_custom', kind: 'pool', external_ref: 'pool_enrollment', label: 'Enrollment Services', parent_ref: null },
  { system_id: 'twilio_custom', kind: 'code', external_ref: '+12085550100', label: 'Admissions line 1', parent_ref: 'pool_admissions' },
  { system_id: 'twilio_custom', kind: 'code', external_ref: '+12085550101', label: 'Admissions line 2', parent_ref: 'pool_admissions' },
];

async function seedServiceTopology(): Promise<void> {
  for (const n of DEMO_TOPOLOGY) {
    await pool.query(
      `INSERT INTO platform_topology (system_id, kind, external_ref, label, parent_ref)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (system_id, kind, external_ref) DO NOTHING`,
      [n.system_id, n.kind, n.external_ref, n.label, n.parent_ref],
    );
  }
}

async function main(): Promise<void> {
  // Ensure the demo's platform set exists and is active before loading adapters —
  // interactive console use may have archived or deleted them, and loadAdapters()
  // only registers active systems. Makes `npm run demo` self-healing.
  await ensureDemoSystems();
  await loadAdapters();
  await reset();

  h('Scenario 1 — consent established, then STOP propagates everywhere');
  await consumer('twilio_custom', 'opt_in', 'web form signup', {
    evidence: {
      method: 'web form',
      consent_language: 'I agree to receive text messages from CSI at this number.',
    },
  });
  await consumer('constant_contact', 'opt_in', 'newsletter signup', {
    evidence: { method: 'web form', consent_language: 'Send me the newsletter.' },
  });
  await printStates('After signups (explicit opt-ins, no propagation):');

  await consumer('twilio_custom', 'opt_out', 'STOP keyword');
  await printStates('After STOP on Twilio (derived suppression fanned out):');
  console.log('  Note: constant_contact, anthology_reach, sms_gateway are suppressed (derived).');

  h('Scenario 2 — explicit opt-out elsewhere, then START triggers a gated review');
  await consumer('constant_contact', 'opt_out', 'unsubscribe link'); // now EXPLICIT out on email
  const startResult = await consumer('twilio_custom', 'opt_in', 'START keyword', {
    evidence: { method: 'START keyword', consent_language: 'START reply to program 55512' },
  });
  await printStates('After START on Twilio (honored locally, review queued):');
  console.log('  Ingest result:', JSON.stringify(startResult.detail));

  const reviews = await pool.query(
    `SELECT ar.id, ar.version, ar.channel, json_agg(json_build_object(
       'system', at.system_id, 'preselected', at.preselected, 'snapshot', at.snapshot_state))
       AS targets
     FROM approval_requests ar JOIN approval_targets at ON at.request_id=ar.id
     WHERE ar.status='pending' GROUP BY ar.id`,
  );
  const review = reviews.rows[0];
  console.log(`\n  Pending review #${review.id} (channel: ${review.channel}):`);
  for (const t of review.targets) {
    console.log(`    ${t.system.padEnd(18)} preselected=${t.preselected}  snapshot=${t.snapshot}`);
  }
  console.log('  Same-channel SMS systems preselected; cross-channel email unchecked.');

  h('Scenario 3 — approval: selective propagation; explicit opt-out is skipped');
  const decision = await decide({
    requestId: review.id,
    version: review.version,
    outcome: 'approved',
    // Reviewer selects both SMS systems AND (incorrectly) constant_contact —
    // the precedence engine must skip the explicit email opt-out.
    selectedTargets: ['anthology_reach', 'sms_gateway', 'constant_contact'],
    attestationText:
      'I have reviewed the consent evidence and confirm it covers the selected systems and channels.',
    decidedBy: 'demo.approver',
  });
  console.log('  Decision result:', JSON.stringify(decision, null, 2).replace(/\n/g, '\n  '));
  await printStates('After approval:');
  console.log('  constant_contact stayed opted_out (explicit) — rule 1 enforced despite selection.');

  h('Scenario 4 — late-arriving batch event reorders the fold');
  // Constant Contact's nightly export delivers an unsubscribe that actually
  // happened BEFORE the explicit opt-out we already know about — harmless.
  // But now simulate one that occurred AFTER a recorded opt-in: a re-subscribe
  // from 2 days ago arrives late, then an unsubscribe from yesterday arrives
  // even later. Final state must follow occurred_at, not arrival order.
  const twoDaysAgo = new Date(Date.now() - 2 * 86400_000);
  const yesterday = new Date(Date.now() - 1 * 86400_000);
  await consumer('constant_contact', 'opt_in', 'late batch: resubscribe form', {
    occurred_at: twoDaysAgo,
    evidence: { method: 'preference center', consent_language: 'Resubscribe me.' },
  });
  await printStates('Late resubscribe (occurred 2 days ago) arrives — but wait:');
  await consumer('constant_contact', 'opt_out', 'late batch: unsubscribe', {
    occurred_at: yesterday,
  });
  await printStates('Then yesterday\'s unsubscribe arrives even later:');
  console.log('  Fold by occurred_at: the unsubscribe (newer) wins regardless of arrival order.');

  h('Scenario 5 — echo suppression: hub writes do not become consumer events');
  const echoes = await pool.query(
    `SELECT count(*)::int AS confirmed FROM hub_writes WHERE confirmed_at IS NOT NULL`,
  );
  const explicitFromEchoes = await pool.query(
    `SELECT count(*)::int AS n FROM consent_events
      WHERE provenance='explicit' AND source_detail LIKE '%echo%'`,
  );
  console.log(`  Hub writes confirmed via echo: ${echoes.rows[0].confirmed}`);
  console.log(`  Echo events recorded as explicit consumer actions: ${explicitFromEchoes.rows[0].n} (must be 0)`);

  h('Scenario 6 — auto-cancel: a pending review dies the moment an opt-out arrives');
  await consumer('anthology_reach', 'opt_in', 'START keyword', {
    evidence: { method: 'START keyword' },
  });
  const pendingBefore = await pool.query(
    `SELECT count(*)::int AS n FROM approval_requests WHERE status='pending'`,
  );
  console.log(`  Pending reviews after new START: ${pendingBefore.rows[0].n}`);
  await consumer('anthology_reach', 'opt_out', 'STOP keyword');
  const canceled = await pool.query(
    `SELECT count(*)::int AS n FROM approval_requests WHERE status='canceled'`,
  );
  const pendingAfter = await pool.query(
    `SELECT count(*)::int AS n FROM approval_requests WHERE status='pending'`,
  );
  console.log(`  After STOP: pending=${pendingAfter.rows[0].n}, canceled=${canceled.rows[0].n}`);
  await printStates('Final states (everything suppressed again):');

  h('Scenario 7 — reconciler catches simulated drift');
  // Simulate a missed webhook: the platform record says opted_in even though
  // the hub expects suppression.
  await pool.query(
    `UPDATE platform_records SET status='opted_in' WHERE system_id='sms_gateway' AND identity_value=$1`,
    [PHONE],
  );
  const rec = await reconcile();
  console.log(`  Reconciler checked ${rec.checked} pairs; corrected:`, rec.corrected);
  console.log('  Alerts:', rec.alerts.length ? rec.alerts : 'none');

  h('Scenario 8 — service-discovered topology (ADR-0002): reporting only');
  await seedServiceTopology();

  // Twilio exposes its sender pools → discover them. Telesign (anthology_reach)
  // cannot report groupings, so it has no discovery and relies on annotation.
  const sync = await syncTopology('twilio_custom', 'demo.operator');
  console.log('  Discovered Twilio topology:', JSON.stringify(sync));
  const telesign = await syncTopology('anthology_reach', 'demo.operator');
  console.log('  Telesign discovery:', JSON.stringify(telesign), '(no machine-readable groupings)');

  // The service adds a third Admissions code; a later sync picks it up
  // automatically — no hand re-entry into the hub.
  await pool.query(
    `INSERT INTO platform_topology (system_id, kind, external_ref, label, parent_ref)
     VALUES ('twilio_custom','code','+12085550102','Admissions line 3','pool_admissions')
     ON CONFLICT DO NOTHING`,
  );
  const sync2 = await syncTopology('twilio_custom', 'demo.operator');
  console.log('  Re-sync after the service added a code:', JSON.stringify(sync2), '(added: 1)');

  // Operator annotates a Telesign code manually; provenance stays separate.
  await annotateCode('anthology_reach', '+12085559000', 'Financial Aid', 'demo.operator');
  // Operator also annotates a Twilio code with a label that DISAGREES with the
  // discovered pool — the hub shows BOTH, never silently overwriting.
  await annotateCode('twilio_custom', '+12085550100', 'Recruiting', 'demo.operator');
  const view = await getTopology('twilio_custom');
  console.log(`  Twilio nodes: ${view.nodes.length}, manual annotations: ${view.annotations.length}`);
  console.log('  Discovery-vs-annotation conflicts (both shown, neither wins):', JSON.stringify(view.conflicts));

  // FIREWALL: topology never drives consent. Two opt-ins land on two different
  // Admissions codes of the SAME system. Consent is per (identity, system) —
  // there is no code-level consent, and no auto-pooling across sibling codes
  // (the superseded ADR-0001 behavior). Topology only labels the events for
  // reporting.
  const A = '+12085551001', B = '+12085551002';
  await consumer('twilio_custom', 'opt_in', 'START on Admissions line 1',
    { phone: A, receiving_code: '+12085550100', evidence: { method: 'START keyword' } });
  await consumer('twilio_custom', 'opt_in', 'START on Admissions line 2',
    { phone: B, receiving_code: '+12085550101', evidence: { method: 'START keyword' } });
  const aId = await resolveIdentity(A);
  const aStates = await getStates(aId.id);
  console.log(`  Person A opted in on Admissions line 1; their system records: ` +
    `${aStates.map((s) => `${s.system_id}=${s.state}`).join(', ')}`);
  console.log('  → No consent was manufactured on sibling codes; topology stayed out of the decision.');

  const attribution = await topologyAttributionReport();
  console.log('  Attribution report (events by receiving code → pool):');
  for (const row of attribution) {
    console.log(`    ${String(row.system_id).padEnd(14)} code ${String(row.receiving_code).padEnd(14)} ` +
      `pool=${row.discovered_pool ?? '—'} manual=${row.manual_group ?? '—'}  events=${row.events}`);
  }

  console.log('\nDemo complete.\n');
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
