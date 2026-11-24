import { pool, migrate } from '../src/db.js';
import { hashPassword } from '../src/auth/passwords.js';
import { DEMO_SYSTEMS, ensureDemoSystems } from './fixtures.js';

/**
 * Registers the initial platform targets (see demo/fixtures.ts) and bootstrap
 * users. The platform set is shared with `npm run demo` via fixtures.ts so the
 * two never drift.
 */

// Simulated service-side topology (ADR-0002): what a discovery-capable service
// would report. The hub never hand-configures this; the topology sync pulls it
// through the adapter. Pools group codes by department.
const PLATFORM_TOPOLOGY = [
  // Twilio sender pools, by department.
  { system_id: 'twilio_custom', kind: 'pool', external_ref: 'pool_admissions', label: 'Admissions', parent_ref: null },
  { system_id: 'twilio_custom', kind: 'pool', external_ref: 'pool_enrollment', label: 'Enrollment Services', parent_ref: null },
  { system_id: 'twilio_custom', kind: 'code', external_ref: '+12085550100', label: 'Admissions line 1', parent_ref: 'pool_admissions' },
  { system_id: 'twilio_custom', kind: 'code', external_ref: '+12085550101', label: 'Admissions line 2', parent_ref: 'pool_admissions' },
  { system_id: 'twilio_custom', kind: 'code', external_ref: '+12085550200', label: 'Enrollment line', parent_ref: 'pool_enrollment' },
  // Constant Contact lists act as pools.
  { system_id: 'constant_contact', kind: 'pool', external_ref: 'list_admissions', label: 'Admissions Newsletter', parent_ref: null },
  { system_id: 'constant_contact', kind: 'code', external_ref: 'cc_admissions', label: 'Admissions list', parent_ref: 'list_admissions' },
];

async function seed(): Promise<void> {
  await migrate();
  await ensureDemoSystems();
  console.log(`seeded ${DEMO_SYSTEMS.length} systems`);

  for (const n of PLATFORM_TOPOLOGY) {
    await pool.query(
      `INSERT INTO platform_topology (system_id, kind, external_ref, label, parent_ref)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (system_id, kind, external_ref)
       DO UPDATE SET label=$4, parent_ref=$5`,
      [n.system_id, n.kind, n.external_ref, n.label, n.parent_ref],
    );
  }
  console.log(`seeded ${PLATFORM_TOPOLOGY.length} simulated service topology nodes`);

  // Bootstrap users on first run. Passwords come from *_BOOTSTRAP_PASSWORD env
  // vars. In production those are REQUIRED — we refuse to seed an account with a
  // built-in default (credential hygiene) and never echo the password
  // to the log. Outside production a dev default is used for convenience.
  const isProd = process.env.NODE_ENV === 'production';
  const userCount = await pool.query('SELECT count(*)::int AS n FROM users');
  if (userCount.rows[0].n === 0) {
    const accounts = [
      { username: 'admin', display: 'Administrator', role: 'admin',
        env: 'ADMIN_BOOTSTRAP_PASSWORD', devDefault: 'ChangeMe-Admin1' },
      { username: 'op.demo', display: 'Demo Operator', role: 'operator',
        env: 'OPERATOR_BOOTSTRAP_PASSWORD', devDefault: 'ChangeMe-Operator1' },
      { username: 'app.demo', display: 'Demo Approver', role: 'approver',
        env: 'APPROVER_BOOTSTRAP_PASSWORD', devDefault: 'ChangeMe-Approver1' },
    ];
    for (const a of accounts) {
      const password = process.env[a.env] ?? (isProd ? undefined : a.devDefault);
      if (!password) {
        throw new Error(
          `${a.env} must be set when NODE_ENV=production — refusing to seed ` +
          `"${a.username}" with a built-in default password.`,
        );
      }
      const u = await pool.query(
        `INSERT INTO users (username, display_name, role) VALUES ($1,$2,$3) RETURNING id`,
        [a.username, a.display, a.role],
      );
      await pool.query(
        `INSERT INTO local_credentials (user_id, password_hash) VALUES ($1,$2)`,
        [u.rows[0].id, await hashPassword(password)],
      );
      // Never print the actual secret in production.
      console.log(isProd
        ? `created ${a.role.padEnd(8)} ${a.username}  (password from ${a.env})`
        : `created ${a.role.padEnd(8)} ${a.username}  password: ${password}`);
    }
    console.log(isProd
      ? 'Bootstrap accounts created from environment-supplied passwords.'
      : 'Bootstrap accounts created — change these passwords.');
  }
  await pool.end();
}

seed().catch((e) => {
  console.error(e);
  process.exit(1);
});
