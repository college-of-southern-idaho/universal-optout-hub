/**
 * Load-test seeder. Populates a THROWAWAY database with mock systems, unlimited
 * API keys, a large identity table, and a realistic mix of consent states, so
 * the consent-check / ingest paths do production-shaped work under load.
 *
 *   DATABASE_URL=... npx tsx loadtest/seed.ts [--systems N] [--identities N] \
 *                        [--base http://host:port] [--clean]
 *
 * Safety: like the integration harness, it refuses to run unless the database
 * name ends in `_test` (override HUB_ALLOW_NONTEST_DB=1). Point it at a database
 * you don't mind filling with junk — never your live hub DB.
 *
 * Writes loadtest/keys.json (the per-system API keys + config) for run.ts.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from '../src/db.js';
import { createApiKey } from '../src/auth/apikeys.js';
import {
  DEFAULT_CONFIG, type LoadConfig, type KeysFile,
  systemIdFor, channelFor, phoneFor, emailFor, seedStateFor, provenanceFor,
  SYSTEM_PREFIX, PHONE_PATTERN, EMAIL_DOMAIN,
} from './dataset.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const KEYS_PATH = join(HERE, 'keys.json');
const BATCH = 5_000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function num(name: string, dflt: number): number {
  const v = arg(name);
  return v === undefined ? dflt : Number(v);
}

async function assertTestDb(): Promise<void> {
  const r = await pool.query<{ db: string }>('SELECT current_database() AS db');
  const db = r.rows[0].db;
  if (!db.endsWith('_test') && process.env.HUB_ALLOW_NONTEST_DB !== '1') {
    throw new Error(
      `refusing to seed non-test database "${db}" — point DATABASE_URL at a *_test ` +
      `database (or set HUB_ALLOW_NONTEST_DB=1 if you really mean it).`,
    );
  }
}

async function clean(): Promise<void> {
  // Child rows first (consent-history FKs are RESTRICT), then keys, systems,
  // and finally the synthetic identities. Tolerate tables that may not exist.
  const steps: Array<[string, string]> = [
    ['consent_states', `DELETE FROM consent_states WHERE system_id LIKE '${SYSTEM_PREFIX}%'`],
    ['consent_events', `DELETE FROM consent_events WHERE system_id LIKE '${SYSTEM_PREFIX}%'`],
    ['hub_writes', `DELETE FROM hub_writes WHERE system_id LIKE '${SYSTEM_PREFIX}%'`],
    ['reconcile_alerts', `DELETE FROM reconcile_alerts WHERE system_id LIKE '${SYSTEM_PREFIX}%'`],
    ['service_api_keys', `DELETE FROM service_api_keys WHERE system_id LIKE '${SYSTEM_PREFIX}%'`],
    ['systems', `DELETE FROM systems WHERE id LIKE '${SYSTEM_PREFIX}%'`],
    ['identities', `DELETE FROM identities WHERE value_normalized LIKE '${PHONE_PATTERN}' OR value_normalized LIKE '%@${EMAIL_DOMAIN}'`],
  ];
  for (const [label, sql] of steps) {
    try {
      const r = await pool.query(sql);
      console.log(`  cleaned ${label}: ${r.rowCount ?? 0}`);
    } catch (e: any) {
      console.log(`  skip ${label}: ${e.message}`);
    }
  }
}

async function seedIdentities(cfg: LoadConfig): Promise<void> {
  const insert = async (kind: 'phone' | 'email', values: string[]) => {
    await pool.query(
      `INSERT INTO identities (kind, value_normalized, value_raw)
       SELECT $1, v, v FROM unnest($2::text[]) v
       ON CONFLICT (value_normalized) DO NOTHING`,
      [kind, values],
    );
  };
  let phones: string[] = [];
  let emails: string[] = [];
  for (let i = 0; i < cfg.identities; i++) {
    phones.push(phoneFor(i));
    emails.push(emailFor(i));
    if (phones.length >= BATCH) { await insert('phone', phones); phones = []; }
    if (emails.length >= BATCH) { await insert('email', emails); emails = []; }
    if (i % 50_000 === 0 && i) console.log(`  identities: ${i * 2}/${cfg.identities * 2}`);
  }
  if (phones.length) await insert('phone', phones);
  if (emails.length) await insert('email', emails);
  console.log(`  identities: ${cfg.identities * 2}/${cfg.identities * 2} done`);
}

async function seedStates(cfg: LoadConfig): Promise<void> {
  const flush = async (systemId: string, state: string, values: string[]) => {
    if (!values.length) return;
    await pool.query(
      `INSERT INTO consent_states (identity_id, system_id, state, provenance)
       SELECT id, $1, $2, $3 FROM identities WHERE value_normalized = ANY($4::text[])
       ON CONFLICT (identity_id, system_id) DO NOTHING`,
      [systemId, state, provenanceFor(state as 'opted_out' | 'suppressed' | 'opted_in'), values],
    );
  };
  for (let k = 0; k < cfg.systems; k++) {
    const sysId = systemIdFor(k);
    const channel = channelFor(k);
    const buckets: Record<string, string[]> = { opted_out: [], suppressed: [], opted_in: [] };
    for (let i = 0; i < cfg.identities; i++) {
      const state = seedStateFor(i, k, cfg);
      if (!state) continue;
      buckets[state].push(channel === 'sms' ? phoneFor(i) : emailFor(i));
      if (buckets[state].length >= BATCH) { await flush(sysId, state, buckets[state]); buckets[state] = []; }
    }
    for (const state of Object.keys(buckets)) await flush(sysId, state, buckets[state]);
    console.log(`  states: ${sysId} (${channel}) done`);
  }
}

async function seedSystemsAndKeys(cfg: LoadConfig): Promise<KeysFile['systems']> {
  const out: KeysFile['systems'] = [];
  // Fresh keys each run: drop any prior load-test keys so keys.json is the truth.
  await pool.query(`DELETE FROM service_api_keys WHERE system_id LIKE '${SYSTEM_PREFIX}%'`);
  for (let k = 0; k < cfg.systems; k++) {
    const id = systemIdFor(k);
    const channel = channelFor(k);
    await pool.query(
      `INSERT INTO systems (id, name, channel, category, event_delivery, can_write_optout, can_write_optin,
          vendor_suppression, can_discover_topology, topology_granularity, adapter_type, connection_status)
       VALUES ($1,$1,$2,'marketing','webhook',true,true,NULL,false,'none','mock','connected')
       ON CONFLICT (id) DO UPDATE SET channel=EXCLUDED.channel`,
      [id, channel],
    );
    // rate_limit_per_sec = 0 → limiter disabled for this key (measure the app,
    // not the throttle). This is the documented load-test knob.
    const { plaintext } = await createApiKey(id, 'loadtest', 'loadtest-seed', 0);
    out.push({ id, channel, apiKey: plaintext });
  }
  return out;
}

async function main(): Promise<void> {
  await assertTestDb();

  if (process.argv.includes('--clean')) {
    console.log('cleaning load-test data…');
    await clean();
    console.log('done.');
    return;
  }

  const cfg: LoadConfig = {
    systems: num('systems', DEFAULT_CONFIG.systems),
    identities: num('identities', DEFAULT_CONFIG.identities),
    optOutRatio: num('opt-out-ratio', DEFAULT_CONFIG.optOutRatio),
    suppressedRatio: num('suppressed-ratio', DEFAULT_CONFIG.suppressedRatio),
    optInRatio: num('opt-in-ratio', DEFAULT_CONFIG.optInRatio),
  };
  const baseUrl = arg('base') ?? process.env.LOADTEST_BASE_URL ?? 'http://localhost:3000';

  console.log(`seeding: ${cfg.systems} systems, ${cfg.identities * 2} identities ` +
    `(${cfg.identities} phones + ${cfg.identities} emails)`);
  const systems = await seedSystemsAndKeys(cfg);
  console.log('systems + keys created');
  await seedIdentities(cfg);
  await seedStates(cfg);

  const keys: KeysFile = { baseUrl, config: cfg, systems };
  writeFileSync(KEYS_PATH, JSON.stringify(keys, null, 2));
  console.log(`\nwrote ${KEYS_PATH} (${systems.length} keys)`);
  console.log('NOTE: restart the hub so it loads the seeded systems for ingest/mixed runs ' +
    '(check-only runs read the DB live and need no restart).');
}

main()
  .then(() => pool.end())
  .catch((e) => { console.error('[seed] failed:', e.message); pool.end(); process.exit(1); });
