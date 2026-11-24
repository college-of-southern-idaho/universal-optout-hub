import { pool } from '../db.js';
import { SETTINGS, SETTING_BY_KEY, SCHEDULER_KEYS, resolvedDefault, validateSetting } from './config-schema.js';

/**
 * Runtime configuration surface (DESIGN.md §13). `policy` is a LIVE object: it
 * is built synchronously from the schema defaults (env-seeded) at import so it's
 * valid immediately, then overlaid with DB values at startup (`hydratePolicy`),
 * and mutated in place when an admin saves (`applyConfig`) — so every `policy.x`
 * read across the codebase sees the current value without a restart.
 *
 * DB (app_config) is authoritative; env only seeds a default. Secrets are never
 * part of this surface (see core/config.ts).
 */
export interface HubPolicy {
  /**
   * Master switch for outbound writes to platforms. ON (default) = production:
   * the hub pushes opt-outs/opt-ins into writable platforms. OFF = test mode:
   * ingest + internal cascade still happen, but nothing is pushed to any sending
   * service (it's logged instead). Gates all three write sites (ingest cascade,
   * reconciler, approval opt-in).
   */
  enableOutboundWrites: boolean;
  // Opt-out propagation scope is governed by the message-category cascade matrix
  // (services/categories.ts, DESIGN.md §10), not a scalar knob here.
  /** When does an explicit opt-in queue a review? */
  reviewTrigger: 'explicit_optout_elsewhere' | 'any_state_elsewhere' | 'never';
  /** Pending review TTL in days. */
  reviewTtlDays: number;
  /** Reset TTL when a same-channel event coalesces into a pending review. */
  ttlResetOnCoalesce: boolean;
  /** Pre-check same-channel systems in the review target list. */
  preselectSameChannel: boolean;
  /** Separation of duties: the operator who initiated cannot approve. */
  initiatorCannotApprove: boolean;
  /** Sync-lag alert threshold in hours (DESIGN.md §8.4). */
  syncLagAlertHours: number;
  /** Consent-check posture for unknown identities (ADR-0004 item 5). */
  consentCheckMode: 'blocklist' | 'allowlist';
  /** Hub-wide default per-key consent-check rate limit, req/s (ADR-0004 §8). */
  consentCheckRateLimitPerSec: number;
  /** Retention for the consent_checks audit, in days (ADR-0004 §7). */
  consentCheckRetainSuppressDays: number;
  consentCheckRetainOtherDays: number;
  /** Retention for the operational audit_log, in days (compliance actions exempt; DESIGN.md §14). */
  auditLogRetainDays: number;
  /** Scheduled-job intervals (0 = disabled). */
  reconcileIntervalMinutes: number;
  pruneIntervalHours: number;
  pollIntervalMinutes: number;
  alertScanMinutes: number;
  /** Default region for parsing phone numbers without a country code. */
  defaultPhoneRegion: string;
  /** Reject inbound webhooks whose signed timestamp is older than this (0 = off). */
  webhookMaxSkewSeconds: number;
}

function buildInitial(): HubPolicy {
  const p: Record<string, unknown> = {};
  for (const s of SETTINGS) p[s.key] = resolvedDefault(s);
  return p as unknown as HubPolicy;
}

/** The live configuration. Read directly; do not reassign the binding. */
export const policy: HubPolicy = buildInitial();

/** Overlay DB-stored config onto the live policy. Call once at startup. */
export async function hydratePolicy(): Promise<void> {
  let rows: { key: string; value: unknown }[];
  try {
    rows = (await pool.query<{ key: string; value: unknown }>('SELECT key, value FROM app_config')).rows;
  } catch (e: any) {
    // e.g. migrations not yet applied — start on env/defaults rather than crash.
    console.warn('[config] could not load app_config, using defaults:', e.message);
    return;
  }
  for (const row of rows) {
    const s = SETTING_BY_KEY.get(row.key);
    if (!s) continue;
    try {
      (policy as unknown as Record<string, unknown>)[row.key] = validateSetting(s, row.value);
    } catch {
      // A stored value that no longer validates (e.g. schema changed) — keep the
      // seeded default rather than crash.
    }
  }
}

/** Settings metadata + current values, for the admin API / Settings UI. */
export function configView() {
  return SETTINGS.map((s) => ({
    key: s.key,
    group: s.group,
    label: s.label,
    help: s.help ?? null,
    kind: s.kind,
    options: s.options ?? null,
    min: s.min ?? null,
    value: (policy as unknown as Record<string, unknown>)[s.key],
  }));
}

/**
 * Validate and persist config updates, mutate the live policy, and audit.
 * Returns which keys changed and whether a scheduler-affecting key changed (the
 * caller reloads the scheduler in that case).
 */
export async function applyConfig(
  updates: Record<string, unknown>,
  by: string,
): Promise<{ changed: string[]; reloadScheduler: boolean }> {
  const changed: string[] = [];
  for (const [key, raw] of Object.entries(updates)) {
    const s = SETTING_BY_KEY.get(key);
    if (!s) throw new Error(`unknown setting: ${key}`);
    const value = validateSetting(s, raw);
    await pool.query(
      `INSERT INTO app_config (key, value, updated_at, updated_by) VALUES ($1,$2,now(),$3)
       ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=now(), updated_by=$3`,
      [key, JSON.stringify(value), by],
    );
    (policy as unknown as Record<string, unknown>)[key] = value;
    changed.push(key);
  }
  if (changed.length) {
    await pool.query(`INSERT INTO audit_log (actor, action, detail) VALUES ($1,'config.update',$2)`, [by, { changed }]);
  }
  return { changed, reloadScheduler: changed.some((k) => SCHEDULER_KEYS.has(k)) };
}
