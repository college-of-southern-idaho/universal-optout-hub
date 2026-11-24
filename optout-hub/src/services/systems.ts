import { pool } from '../db.js';
import { loadAdapters, getAdapter } from '../adapters/registry.js';
import {
  getAdapterTypeSpec, isAdapterType, isKnownCredentialKey, requiredCredentialKeys,
  ADAPTER_CATALOG,
} from '../adapters/catalog.js';
import { encryptSecret, last4 } from '../core/secrets.js';
import { isKnownCategory, isAssignableCategory } from './categories.js';
import type { Channel, CredentialMeta, SystemRow, TopologyGranularity } from '../core/types.js';

/**
 * Service configuration (DESIGN.md §9; migration 005).
 *
 * Backs the admin "Services" screens. Phase 1 (register & connect) lives here;
 * phase 2 (discover & review) reuses services/topology.ts. Nothing here records
 * a consent_event, and the operational fields (adapter_type, capabilities,
 * credentials, topology) never drive a consent decision (ADR-0002 §2.2). The two
 * deliberate exceptions are the consent-classification fields `channel` and
 * `category`: they ARE consent-relevant — channel scopes opt-in review, category
 * governs which services an opt-out cascades to (DESIGN.md §10).
 */

const GRANULARITIES: TopologyGranularity[] = ['none', 'code', 'pool', 'group'];
const DELIVERIES = ['webhook', 'poll', 'export'] as const;
const ID_RE = /^[a-z0-9][a-z0-9_-]{1,40}$/;

export interface SystemInput {
  id?: string;
  name?: string;
  adapter_type?: string;
  channel?: string;
  category?: string;
  event_delivery?: string;
  can_write_optout?: boolean;
  can_write_optin?: boolean;
  can_discover_topology?: boolean;
  topology_granularity?: string;
  vendor_suppression?: string | null;
}

export interface ResolvedSystemFields {
  id: string;
  name: string;
  adapter_type: string;
  channel: Channel;
  category: string;
  event_delivery: string;
  can_write_optout: boolean;
  can_write_optin: boolean;
  can_discover_topology: boolean;
  topology_granularity: TopologyGranularity;
  vendor_suppression: string | null;
}

const bool = (v: unknown, fallback: boolean): boolean =>
  typeof v === 'boolean' ? v : fallback;

/**
 * Pure: validate + normalize register/configure input against the adapter
 * catalog and the systems CHECK constraints. `existing` is the current row on
 * update, null on create. Throws on invalid input; no DB access (unit-tested).
 *
 * Enforces the rules that would otherwise only surface as a DB error or, worse,
 * a silent inconsistency: channel-locked types are forced to their channel;
 * a system that can't discover topology is pinned to 'none' granularity;
 * adapter_type is immutable after creation.
 */
export function resolveSystemFields(
  input: SystemInput,
  existing: SystemRow | null,
): ResolvedSystemFields {
  const adapterType = existing ? existing.adapter_type : String(input.adapter_type ?? '').trim();
  if (!isAdapterType(adapterType)) {
    throw new Error(`unknown adapter type "${adapterType}"`);
  }
  const spec = getAdapterTypeSpec(adapterType)!;

  const id = existing ? existing.id : String(input.id ?? '').trim();
  if (!existing && !ID_RE.test(id)) {
    throw new Error('id must be 2–41 chars, lowercase letters/digits/_/- and start alphanumeric');
  }

  const name = (input.name ?? existing?.name ?? '').trim();
  if (!name) throw new Error('name is required');

  // Channel: locked types ignore any override (consent classification, §9).
  let channel: string;
  if (spec.channel_locked) {
    channel = spec.channel;
  } else {
    channel = String(input.channel ?? existing?.channel ?? spec.channel);
  }
  if (channel !== 'sms' && channel !== 'email') throw new Error('channel must be sms or email');

  // Message category (DESIGN.md §10). Format-checked here (pure); existence is
  // enforced against the live registry in register/updateSystem and by the FK.
  const category = String(input.category ?? existing?.category ?? 'marketing').trim();
  if (!ID_RE.test(category)) {
    throw new Error('category must be 2–41 chars, lowercase letters/digits/_/- and start alphanumeric');
  }

  const event_delivery = String(input.event_delivery ?? existing?.event_delivery ?? spec.defaults.event_delivery);
  if (!(DELIVERIES as readonly string[]).includes(event_delivery)) {
    throw new Error("event_delivery must be webhook, poll, or export");
  }

  const can_write_optout = bool(input.can_write_optout, existing?.can_write_optout ?? spec.defaults.can_write_optout);
  const can_write_optin = bool(input.can_write_optin, existing?.can_write_optin ?? spec.defaults.can_write_optin);
  const can_discover_topology = bool(input.can_discover_topology, existing?.can_discover_topology ?? spec.defaults.can_discover_topology);

  // Granularity is meaningless without discovery — pin it to 'none' so the two
  // can never drift into a contradictory pair.
  let topology_granularity = String(
    input.topology_granularity ?? existing?.topology_granularity ?? spec.defaults.topology_granularity,
  );
  if (!can_discover_topology) topology_granularity = 'none';
  if (!(GRANULARITIES as string[]).includes(topology_granularity)) {
    throw new Error('topology_granularity must be none, code, pool, or group');
  }

  const vendorRaw = input.vendor_suppression ?? existing?.vendor_suppression ?? null;
  const vendor_suppression = vendorRaw === null ? null : String(vendorRaw).trim() || null;

  return {
    id, name, adapter_type: adapterType, channel: channel as Channel, category, event_delivery,
    can_write_optout, can_write_optin, can_discover_topology,
    topology_granularity: topology_granularity as TopologyGranularity, vendor_suppression,
  };
}

// ---- DB-backed operations ---------------------------------------------------

interface Actor { id: number | null; name: string | null; }

async function audit(by: Actor, action: string, detail: unknown): Promise<void> {
  await pool.query(
    'INSERT INTO audit_log (actor, actor_user_id, action, detail) VALUES ($1,$2,$3,$4)',
    [by.name, by.id, action, JSON.stringify(detail)],
  );
}

async function getSystemRow(id: string): Promise<SystemRow | null> {
  const r = await pool.query<SystemRow>('SELECT * FROM systems WHERE id=$1', [id]);
  return r.rows[0] ?? null;
}

export function listAdapterTypes() {
  return ADAPTER_CATALOG;
}

/** Register a new sending service (phase 1). Reloads the adapter registry so
 *  the new system is immediately testable and discoverable. */
export async function registerSystem(input: SystemInput, by: Actor): Promise<SystemRow> {
  const f = resolveSystemFields(input, null);
  if (await getSystemRow(f.id)) throw new Error(`a system with id "${f.id}" already exists`);
  if (!isKnownCategory(f.category)) throw new Error(`unknown category "${f.category}"`);
  if (!isAssignableCategory(f.category)) throw new Error(`category "${f.category}" is archived — unarchive it or pick another`);

  await pool.query(
    `INSERT INTO systems
       (id, name, channel, category, event_delivery, can_write_optout, can_write_optin,
        vendor_suppression, can_discover_topology, topology_granularity,
        adapter_type, connection_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'draft')`,
    [f.id, f.name, f.channel, f.category, f.event_delivery, f.can_write_optout, f.can_write_optin,
     f.vendor_suppression, f.can_discover_topology, f.topology_granularity, f.adapter_type],
  );
  await audit(by, 'system_registered', { id: f.id, adapter_type: f.adapter_type, channel: f.channel });
  await loadAdapters();
  return (await getSystemRow(f.id))!;
}

/** Update an existing service's configuration (phase 1). adapter_type and id
 *  are immutable; everything else is re-validated against the catalog. */
export async function updateSystem(id: string, input: SystemInput, by: Actor): Promise<SystemRow> {
  const existing = await getSystemRow(id);
  if (!existing) throw new Error(`unknown system "${id}"`);
  const f = resolveSystemFields(input, existing);
  // Keeping the current category is always allowed (even if it was archived);
  // only CHANGING to a non-assignable category is refused.
  if (f.category !== existing.category) {
    if (!isKnownCategory(f.category)) throw new Error(`unknown category "${f.category}"`);
    if (!isAssignableCategory(f.category)) throw new Error(`category "${f.category}" is archived — pick an active category`);
  }

  await pool.query(
    `UPDATE systems SET
       name=$2, channel=$3, category=$4, event_delivery=$5, can_write_optout=$6, can_write_optin=$7,
       vendor_suppression=$8, can_discover_topology=$9, topology_granularity=$10
     WHERE id=$1`,
    [id, f.name, f.channel, f.category, f.event_delivery, f.can_write_optout, f.can_write_optin,
     f.vendor_suppression, f.can_discover_topology, f.topology_granularity],
  );
  await audit(by, 'system_updated', { id, channel: f.channel, can_write_optout: f.can_write_optout });
  await loadAdapters();
  return (await getSystemRow(id))!;
}

// ---- Archive / delete -------------------------------------------------------
// Consent history is append-only and must outlive the service that produced it.
// Tables that carry it (RESTRICT FKs to systems): consent_events, consent_states,
// hub_writes, approval_targets, reconcile_alerts.
const CONSENT_HISTORY_TABLES = [
  'consent_events', 'consent_states', 'hub_writes', 'approval_targets', 'reconcile_alerts',
] as const;
// Config/operational children that a hard delete may remove (credentials cascade).
const CONFIG_CHILD_TABLES = [
  'code_annotations', 'topology_nodes', 'platform_topology', 'platform_records',
] as const;

/** Whether a system has any consent history (and is therefore archive-only). */
export async function hasConsentHistory(systemId: string): Promise<boolean> {
  const union = CONSENT_HISTORY_TABLES
    .map((t) => `SELECT 1 FROM ${t} WHERE system_id=$1`)
    .join(' UNION ALL ');
  const r = await pool.query(`SELECT EXISTS (${union}) AS has`, [systemId]);
  return r.rows[0]?.has === true;
}

/** Soft delete: stop using the system, keep its history. */
export async function archiveSystem(id: string, by: Actor): Promise<SystemRow> {
  const existing = await getSystemRow(id);
  if (!existing) throw new Error(`unknown system "${id}"`);
  await pool.query('UPDATE systems SET archived_at=now() WHERE id=$1', [id]);
  await audit(by, 'system_archived', { id });
  await loadAdapters();               // drops it from the active registry
  return (await getSystemRow(id))!;
}

export async function unarchiveSystem(id: string, by: Actor): Promise<SystemRow> {
  const existing = await getSystemRow(id);
  if (!existing) throw new Error(`unknown system "${id}"`);
  await pool.query('UPDATE systems SET archived_at=NULL WHERE id=$1', [id]);
  await audit(by, 'system_unarchived', { id });
  await loadAdapters();
  return (await getSystemRow(id))!;
}

/** Raised when a hard delete is refused because consent history exists. */
export class HasHistoryError extends Error {
  code = 'has_history' as const;
  constructor(id: string) {
    super(`system "${id}" has consent history and cannot be deleted; archive it instead`);
  }
}

/**
 * Hard delete — permitted ONLY for a system with no consent history (typically a
 * never-used or misconfigured registration). Removes config/metadata children
 * and the system row in one transaction. The consent-table RESTRICT FKs are the
 * backstop: if history slipped past the check, the DB aborts the transaction.
 */
export async function deleteSystem(id: string, by: Actor): Promise<void> {
  const existing = await getSystemRow(id);
  if (!existing) throw new Error(`unknown system "${id}"`);
  if (await hasConsentHistory(id)) throw new HasHistoryError(id);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const t of CONFIG_CHILD_TABLES) {
      await client.query(`DELETE FROM ${t} WHERE system_id=$1`, [id]);
    }
    await client.query('DELETE FROM systems WHERE id=$1', [id]);  // credentials cascade
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  await audit(by, 'system_deleted', { id, adapter_type: existing.adapter_type });
  await loadAdapters();
}

// ---- Credentials: write-only, encrypted at rest -----------------------------

export interface CredentialEntry { key: string; value: string; expires_at?: string | null; }

/**
 * Set one or more credentials for a system. Values are encrypted at rest and
 * NEVER read back through the API. Blank values are ignored (use clearCredential
 * to remove one); unknown keys for the adapter type are rejected. An optional
 * expires_at carries an OAuth access-token expiry. The audit log records which
 * keys changed — never the values.
 */
export async function setCredentials(
  systemId: string, entries: CredentialEntry[], by: Actor,
): Promise<CredentialMeta[]> {
  const sys = await getSystemRow(systemId);
  if (!sys) throw new Error(`unknown system "${systemId}"`);

  const written: string[] = [];
  for (const e of entries ?? []) {
    const key = String(e?.key ?? '').trim();
    const value = e?.value == null ? '' : String(e.value);
    if (!key || value === '') continue;                 // blank → leave untouched
    if (!isKnownCredentialKey(sys.adapter_type, key)) {
      throw new Error(`"${key}" is not a credential for adapter type ${sys.adapter_type}`);
    }
    const expiresAt = e?.expires_at ? new Date(e.expires_at) : null;
    await pool.query(
      `INSERT INTO system_credentials
         (system_id, cred_key, secret_enc, last4, expires_at, updated_at, updated_by, updated_by_user_id)
       VALUES ($1,$2,$3,$4,$5, now(), $6, $7)
       ON CONFLICT (system_id, cred_key)
       DO UPDATE SET secret_enc=$3, last4=$4, expires_at=$5, updated_at=now(), updated_by=$6, updated_by_user_id=$7`,
      [systemId, key, encryptSecret(value), last4(value), expiresAt, by.name, by.id],
    );
    written.push(key);
  }
  if (written.length) await audit(by, 'system_credentials_set', { system_id: systemId, keys: written });
  if (written.length) await loadAdapters();   // live adapters pick up new/rotated secrets
  return getCredentialMeta(systemId);
}

export async function clearCredential(systemId: string, key: string, by: Actor): Promise<boolean> {
  const r = await pool.query(
    'DELETE FROM system_credentials WHERE system_id=$1 AND cred_key=$2', [systemId, key],
  );
  const removed = (r.rowCount ?? 0) > 0;
  if (removed) await audit(by, 'system_credential_cleared', { system_id: systemId, key });
  if (removed) await loadAdapters();
  return removed;
}

/** Metadata only — which keys are set, a last-4 hint, and provenance. Never the secret. */
export async function getCredentialMeta(systemId: string): Promise<CredentialMeta[]> {
  const r = await pool.query<CredentialMeta>(
    `SELECT cred_key, last4, updated_at, updated_by, expires_at
       FROM system_credentials WHERE system_id=$1 ORDER BY cred_key`,
    [systemId],
  );
  return r.rows;
}

// Re-exported from the credential store (kept here for API stability). Used by
// real adapters at send/discovery time; never exposed through an HTTP route.
export { getDecryptedCredentials } from '../adapters/credential-store.js';

// ---- Connection test --------------------------------------------------------

export interface ConnectionCheck { name: string; ok: boolean; required: boolean; detail: string; }
export interface ConnectionResult { ok: boolean; status: 'connected' | 'error'; checks: ConnectionCheck[]; }

/**
 * Test a system's connection (phase 1). Runs a few cheap checks — required
 * credentials present, channel/discovery consistency, and an adapter probe —
 * and records the outcome on the system (connection_status / last_test_*) for
 * the admin list. A production adapter would authenticate against the real
 * platform here; the mock confirms its backing store is reachable.
 */
export async function testConnection(systemId: string, by: Actor): Promise<ConnectionResult> {
  const sys = await getSystemRow(systemId);
  if (!sys) throw new Error(`unknown system "${systemId}"`);
  const spec = getAdapterTypeSpec(sys.adapter_type);
  const checks: ConnectionCheck[] = [];

  // Required credentials present.
  const have = new Set((await getCredentialMeta(systemId)).map((c) => c.cred_key));
  const missing = requiredCredentialKeys(sys.adapter_type).filter((k) => !have.has(k));
  checks.push({
    name: 'Required credentials',
    ok: missing.length === 0,
    required: true,
    detail: missing.length ? `missing: ${missing.join(', ')}` : (have.size ? 'all present' : 'none required'),
  });

  // Channel classification matches a locked adapter type.
  if (spec?.channel_locked) {
    checks.push({
      name: 'Channel classification',
      ok: sys.channel === spec.channel,
      required: true,
      detail: sys.channel === spec.channel ? `${sys.channel} (locked)` : `must be ${spec.channel} for this type`,
    });
  }

  // Adapter probe (reload first so a just-registered system is in the registry).
  await loadAdapters();
  try {
    const adapter = getAdapter(systemId);
    const probe = await adapter.probe();
    checks.push({ name: 'Adapter reachable', ok: probe.ok, required: true, detail: probe.detail });
  } catch (e: any) {
    checks.push({ name: 'Adapter reachable', ok: false, required: true, detail: e.message });
  }

  // Discovery capability — informational, never blocks a connection.
  checks.push({
    name: 'Topology discovery',
    ok: true,
    required: false,
    detail: sys.can_discover_topology
      ? `on (granularity: ${sys.topology_granularity})`
      : 'off — codes grouped by manual annotation',
  });

  const ok = checks.filter((c) => c.required).every((c) => c.ok);
  const summary = checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('; ') || 'all checks passed';
  await pool.query(
    'UPDATE systems SET connection_status=$2, last_test_at=now(), last_test_detail=$3 WHERE id=$1',
    [systemId, ok ? 'connected' : 'error', summary],
  );
  await audit(by, 'system_connection_tested', { system_id: systemId, ok, summary });
  return { ok, status: ok ? 'connected' : 'error', checks };
}
