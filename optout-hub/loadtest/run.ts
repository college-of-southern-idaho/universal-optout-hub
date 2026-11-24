/**
 * Load generator for the consent hub. Zero external deps — uses Node's global
 * fetch (undici pools connections per origin). Reads loadtest/keys.json (written
 * by seed.ts) for the base URL + per-system API keys, then drives a closed-loop
 * workload and reports latency percentiles, throughput, and error/429 rates.
 *
 *   npx tsx loadtest/run.ts [--mode check|report|mixed] [--batch N]
 *       [--connections C --duration S]           # constant load, OR
 *       [--ramp 10,25,50,100,200 --stage-seconds S]  # staged ramp to find the knee
 *       [--p99-slo MS] [--out results.json] [--base URL] [--keys path]
 *
 * check  — POST /api/v1/consent/check (the per-send hot path). Default.
 * report — POST /api/v1/consent/report (inbound opt-out; write + cascade).
 * mixed  — ~90% check / ~8% report / ~2% suppressions feed.
 *
 * "Find the breaking point": pass --ramp and watch p99/errors climb; the stage
 * where p99 crosses --p99-slo (or errors climb) is your ceiling on this box.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  type KeysFile, type Channel, identityFor,
} from './dataset.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function num(name: string, dflt: number): number {
  const v = arg(name);
  return v === undefined ? dflt : Number(v);
}

type Mode = 'check' | 'report' | 'mixed';

const keysPath = arg('keys') ?? join(HERE, 'keys.json');
const keys: KeysFile = JSON.parse(readFileSync(keysPath, 'utf8'));
const baseUrl = (arg('base') ?? keys.baseUrl).replace(/\/$/, '');
const mode = (arg('mode') ?? 'check') as Mode;
const batch = num('batch', 1);
const idCount = keys.config.identities;
const p99Slo = arg('p99-slo') ? Number(arg('p99-slo')) : null;

const randInt = (n: number): number => Math.floor(Math.random() * n);
const pickSystem = () => keys.systems[randInt(keys.systems.length)];

interface Stat {
  latencies: number[];
  ok: number;
  errors: number;
  rateLimited: number;
  byStatus: Map<number, number>;
}
function newStat(): Stat {
  return { latencies: [], ok: 0, errors: 0, rateLimited: 0, byStatus: new Map() };
}

function record(stat: Stat, status: number, ms: number): void {
  stat.latencies.push(ms);
  stat.byStatus.set(status, (stat.byStatus.get(status) ?? 0) + 1);
  if (status === 429) stat.rateLimited++;
  if (status >= 200 && status < 300) stat.ok++;
  else stat.errors++;
}

/** One request per the chosen mode. Returns the HTTP status (0 on transport error). */
async function fireOne(m: Mode): Promise<number> {
  const roll = m === 'mixed' ? Math.random() : m === 'report' ? 0.95 : 0;
  const kind: 'check' | 'report' | 'feed' =
    m === 'check' ? 'check'
    : m === 'report' ? 'report'
    : roll < 0.9 ? 'check' : roll < 0.98 ? 'report' : 'feed';

  const sys = pickSystem();
  const headers = { 'content-type': 'application/json', 'x-api-key': sys.apiKey };
  try {
    if (kind === 'check') {
      const identities = Array.from({ length: batch }, () => identityFor(sys.channel as Channel, randInt(idCount)));
      const res = await fetch(`${baseUrl}/api/v1/consent/check`, {
        method: 'POST', headers,
        body: JSON.stringify({ system: sys.id, channel: sys.channel, identities }),
      });
      await res.arrayBuffer(); // drain so the socket is reused
      return res.status;
    }
    if (kind === 'report') {
      const value = identityFor(sys.channel as Channel, randInt(idCount));
      const res = await fetch(`${baseUrl}/api/v1/consent/report`, {
        method: 'POST', headers,
        body: JSON.stringify({ system: sys.id, value, direction: 'opt_out', source: 'loadtest' }),
      });
      await res.arrayBuffer();
      return res.status;
    }
    const res = await fetch(`${baseUrl}/api/v1/consent/suppressions?system=${sys.id}`, { headers });
    await res.arrayBuffer();
    return res.status;
  } catch {
    return 0; // transport error (connection refused, reset, timeout)
  }
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

interface StageResult {
  connections: number;
  seconds: number;
  total: number;
  rps: number;
  ok: number;
  errors: number;
  rateLimited: number;
  p50: number; p90: number; p95: number; p99: number; max: number;
  statuses: Record<string, number>;
}

/** Run `connections` closed-loop workers for `seconds`; collect one Stat. */
async function runStage(connections: number, seconds: number, m: Mode): Promise<StageResult> {
  const stat = newStat();
  const endAt = performance.now() + seconds * 1000;
  const worker = async (): Promise<void> => {
    while (performance.now() < endAt) {
      const t0 = performance.now();
      const status = await fireOne(m);
      record(stat, status, performance.now() - t0);
    }
  };
  const startedAt = performance.now();
  await Promise.all(Array.from({ length: connections }, () => worker()));
  const elapsed = (performance.now() - startedAt) / 1000;

  const sorted = stat.latencies.slice().sort((a, b) => a - b);
  return {
    connections, seconds: Number(elapsed.toFixed(1)),
    total: sorted.length,
    rps: Math.round(sorted.length / elapsed),
    ok: stat.ok, errors: stat.errors, rateLimited: stat.rateLimited,
    p50: Math.round(percentile(sorted, 50)),
    p90: Math.round(percentile(sorted, 90)),
    p95: Math.round(percentile(sorted, 95)),
    p99: Math.round(percentile(sorted, 99)),
    max: Math.round(sorted[sorted.length - 1] ?? 0),
    statuses: Object.fromEntries(stat.byStatus),
  };
}

function printHeader(): void {
  console.log(`\ntarget   ${baseUrl}   mode=${mode}   batch=${batch}   identities/pool=${idCount}`);
  console.log('conns   rps     p50    p95    p99    max    ok      err   429   statuses');
  console.log('─'.repeat(78));
}
function printRow(r: StageResult): void {
  const flag = p99Slo && r.p99 > p99Slo ? ' ⚠ p99>slo' : '';
  console.log(
    `${String(r.connections).padEnd(6)}  ${String(r.rps).padEnd(6)}  ` +
    `${String(r.p50).padEnd(5)}  ${String(r.p95).padEnd(5)}  ${String(r.p99).padEnd(5)}  ` +
    `${String(r.max).padEnd(5)}  ${String(r.ok).padEnd(6)}  ${String(r.errors).padEnd(4)}  ` +
    `${String(r.rateLimited).padEnd(4)}  ${JSON.stringify(r.statuses)}${flag}`,
  );
}

async function main(): Promise<void> {
  const results: StageResult[] = [];
  printHeader();

  const rampArg = arg('ramp');
  if (rampArg) {
    const stages = rampArg.split(',').map((s) => Number(s.trim())).filter((n) => n > 0);
    const stageSeconds = num('stage-seconds', 20);
    for (const c of stages) {
      const r = await runStage(c, stageSeconds, mode);
      results.push(r);
      printRow(r);
    }
  } else {
    const r = await runStage(num('connections', 50), num('duration', 30), mode);
    results.push(r);
    printRow(r);
  }

  // Summary + optional SLO verdict.
  const worst = results[results.length - 1];
  console.log('─'.repeat(78));
  const peak = results.reduce((a, b) => (b.rps > a.rps ? b : a), results[0]);
  console.log(`peak sustained: ${peak.rps} req/s at ${peak.connections} conns (p99 ${peak.p99}ms)`);
  if (p99Slo) {
    const passing = results.filter((r) => r.p99 <= p99Slo && r.errors === 0);
    const best = passing.reduce((a, b) => (b.rps > (a?.rps ?? -1) ? b : a), null as StageResult | null);
    console.log(best
      ? `SLO (p99 ≤ ${p99Slo}ms, 0 errors): PASS up to ${best.rps} req/s (${best.connections} conns)`
      : `SLO (p99 ≤ ${p99Slo}ms, 0 errors): FAIL at every stage`);
  }
  if (worst.errors > 0 || worst.rateLimited > 0) {
    console.log(`note: final stage had ${worst.errors} errors, ${worst.rateLimited} rate-limited (429).`);
  }

  const outPath = arg('out');
  if (outPath) {
    writeFileSync(outPath, JSON.stringify({ baseUrl, mode, batch, config: keys.config, results }, null, 2));
    console.log(`wrote ${outPath}`);
  }
}

main().catch((e) => { console.error('[loadtest] failed:', e.message); process.exit(1); });
