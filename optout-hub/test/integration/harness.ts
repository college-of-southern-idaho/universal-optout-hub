/**
 * Integration-test harness. These tests exercise the real DB-backed paths
 * (ingest -> projection -> propagation, the approval workflow, consent-check,
 * reporting) against a THROWAWAY PostgreSQL — never the dev/prod database.
 *
 * The app pool reads DATABASE_URL, so the `test:integration` npm script points
 * it at a dedicated `*_test` database. Every helper here is safe to run only
 * against such a DB: reset() TRUNCATEs everything. If no database is reachable
 * (e.g. CI without Postgres) the tests skip gracefully via dbAvailable().
 */
import { pool, migrate } from '../../src/db.js';
import { hydrateCategories } from '../../src/services/categories.js';
import { hydratePolicy } from '../../src/core/policy.js';
import { loadAdapters } from '../../src/adapters/registry.js';

let availability: boolean | null = null;

/**
 * Is a THROWAWAY test database reachable? Integration tests skip if not.
 *
 * Safety rail: reset() TRUNCATEs every table, so we refuse to run against any
 * database whose name doesn't end in `_test` (override with HUB_ALLOW_NONTEST_DB=1
 * only if you truly mean it). This makes it impossible to nuke dev/prod by
 * pointing DATABASE_URL at the wrong place.
 */
export async function dbAvailable(): Promise<boolean> {
  if (availability !== null) return availability;
  try {
    const r = await pool.query<{ db: string }>('SELECT current_database() AS db');
    const db = r.rows[0].db;
    if (!db.endsWith('_test') && process.env.HUB_ALLOW_NONTEST_DB !== '1') {
      console.warn(
        `[integration] refusing to run against non-test database "${db}" — ` +
        `point DATABASE_URL at a *_test database (or set HUB_ALLOW_NONTEST_DB=1). Skipping.`,
      );
      availability = false;
    } else {
      availability = true;
    }
  } catch {
    availability = false;
  }
  return availability;
}

/** node:test skip descriptor when there's no test DB. */
export async function skipUnlessDb(): Promise<{ skip: string } | Record<string, never>> {
  return (await dbAvailable()) ? {} : { skip: 'no test database (set TEST_DATABASE_URL to a throwaway Postgres)' };
}

let migrated = false;
/** Apply migrations once for the run (idempotent/rerun-safe). */
export async function setup(): Promise<void> {
  if (migrated) return;
  await migrate();
  migrated = true;
}

/**
 * Clean per-test state: TRUNCATE every table, then re-seed the default category
 * set + cascade matrix (migration 016) and refresh the in-memory caches, so each
 * test starts from a known-good baseline and may freely mutate categories/policy.
 */
export async function reset(): Promise<void> {
  const { rows } = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname='public'`,
  );
  if (rows.length) {
    const tables = rows.map((r) => `"${r.tablename}"`).join(', ');
    await pool.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
  }
  await pool.query(
    `INSERT INTO consent_categories (key, label, protected, sort_order) VALUES
       ('marketing','Marketing',false,10),('transactional','Transactional',false,20),('emergency','Emergency',true,30)
     ON CONFLICT DO NOTHING`,
  );
  await pool.query(
    `INSERT INTO consent_category_cascade (source, target) VALUES
       ('marketing','marketing'),('transactional','transactional'),('transactional','marketing')
     ON CONFLICT DO NOTHING`,
  );
  await hydratePolicy();
  await hydrateCategories();
  await loadAdapters();
}

/** Insert a mock-backed system and reload the adapter registry so it's live. */
export async function seedSystem(f: {
  id: string; channel?: 'sms' | 'email'; category?: string;
  can_write_optout?: boolean; can_write_optin?: boolean;
}): Promise<void> {
  await pool.query(
    `INSERT INTO systems (id, name, channel, category, event_delivery, can_write_optout, can_write_optin,
        vendor_suppression, can_discover_topology, topology_granularity, adapter_type, connection_status)
     VALUES ($1,$1,$2,$3,'webhook',$4,$5,NULL,false,'none','mock','connected')`,
    [f.id, f.channel ?? 'sms', f.category ?? 'marketing', f.can_write_optout ?? true, f.can_write_optin ?? true],
  );
  await loadAdapters();
}

/** Current consent states for an identity value, keyed by system id. */
export async function statesFor(value: string): Promise<Record<string, { state: string; provenance: string | null }>> {
  const r = await pool.query<{ system_id: string; state: string; provenance: string | null }>(
    `SELECT cs.system_id, cs.state, cs.provenance
       FROM consent_states cs JOIN identities i ON i.id = cs.identity_id
      WHERE i.value_normalized = $1`,
    [value],
  );
  return Object.fromEntries(r.rows.map((x) => [x.system_id, { state: x.state, provenance: x.provenance }]));
}
