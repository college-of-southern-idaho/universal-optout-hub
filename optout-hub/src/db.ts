import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readSecret, isProd } from './core/config.js';

const { Pool } = pg;

// DATABASE_URL carries the DB password, so resolve it like any secret (supports
// DATABASE_URL_FILE for a mounted secret). Required in production; a dev default
// keeps local `docker compose` frictionless.
const connectionString =
  readSecret('DATABASE_URL') ??
  (isProd()
    ? (() => { throw new Error('DATABASE_URL is required in production — set DATABASE_URL or DATABASE_URL_FILE.'); })()
    : 'postgres://postgres:postgres@localhost:5432/optout_hub');

// Pool size is the first throughput ceiling under load: node-postgres defaults
// to max 10, so an 11th concurrent request queues for a connection. Tune via
// PG_POOL_MAX for higher-traffic deployments (keep it below Postgres's
// max_connections, accounting for every app instance). See PERFORMANCE.md.
const poolMax = Number(process.env.PG_POOL_MAX ?? 10);
export const pool = new Pool({
  connectionString,
  max: Number.isFinite(poolMax) && poolMax > 0 ? poolMax : 10,
});

// A Pool emits 'error' when an IDLE client fails (backend closed the connection,
// network blip, etc.). Without a listener node-postgres turns that into an
// uncaught exception that kills the process — so always listen. This is a
// resilience log, not a request error; the affected client is discarded and the
// pool recovers on the next query.
pool.on('error', (err) => {
  console.error('[db] idle client error (pool recovers):', err.message);
});

export async function migrate(): Promise<void> {
  const dir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../db/migrations',
  );
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = readFileSync(path.join(dir, f), 'utf8');
    await pool.query(sql);
    console.log(`applied ${f}`);
  }
}

// `npm run migrate`
if (process.argv[2] === 'migrate') {
  migrate()
    .then(() => pool.end())
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
