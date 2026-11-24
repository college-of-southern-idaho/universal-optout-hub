import { createHmac } from 'node:crypto';
import type { Adapter, WriteResult, PolledEvent } from './contract.js';
import type { Direction, DiscoveredNode, SystemRow } from '../core/types.js';
import { log } from '../core/logger.js';

/**
 * Modern Campus Message (formerly Signal Vine) — higher-ed conversational SMS.
 *
 * Pattern B (withhold-only), POLL delivery. Grounded in the official OpenAPI spec
 * (gitlab.com/signalvine/public-api), server https://theseus-api.signalvine.com.
 *
 *   probe            → GET /v1/accounts/{id}                         (authenticate)
 *   observe          → not read per-identity (withhold-only) → 'none'
 *   write            → refused: no confirmed caller-writable suppression (see below)
 *   pollOptOuts      → GET /v2/programs/{id}/contacts?active=false   (per program)
 *   discoverTopology → programs/groups exist but not enabled by default → []
 *
 * Auth is Modern Campus's HMAC-SHA256 request signing: an org-level token+secret
 * (from app.signalvine.com/sv/settings/api). Each request is signed over
 * token/verb/path/body/timestamp (all lowercased except the body) and carries
 * `SignalVine-Date` + `Authorization: SignalVine <token>:<base64 sig>`. Signatures
 * are valid 90s, so host clock skew shows up as 401.
 *
 * WRITE is intentionally refused for now. The platform has no send-time API, so a
 * hub opt-out could only be pushed by setting a contact `active=false` via
 * POST /v2/programs/{id}/participants — but it is UNCONFIRMED whether `active` is
 * writable via upload and whether it actually withholds sends. Until the vendor
 * confirms, opt-outs are enforced by withholding, and this adapter only ingests.
 *
 * UNPROVEN: built and unit-tested at the signing/mapping layer, never run against
 * a live account. The response bodies are not schematized in the spec, so the
 * contact field mapping (`mapInactiveContacts`) encodes a best-guess shape and is
 * flagged for verification against a real payload before go-live.
 */

const API_BASE = 'https://theseus-api.signalvine.com';
const PAGE = 250;          // spec recommends <=250 items/page
const MAX_PAGES = 200;     // safety cap against a runaway paging loop

interface HttpResult { status: number; ok: boolean; json: any; text: string }

/**
 * Build the Modern Campus `Authorization` header value. Pure + exported for tests.
 * String to sign = token \n verb \n path \n body \n timestamp, joined with '\n';
 * everything except the body is lowercased; HMAC-SHA256 keyed by the secret,
 * base64-encoded. Path is the request path only (no host, no query string).
 */
export function signalVineAuth(input: {
  token: string; secret: string; verb: string; path: string; body: string; timestamp: string;
}): string {
  const stringToSign = [
    input.token.toLowerCase(),
    input.verb.toLowerCase(),
    input.path.toLowerCase(),
    input.body,                       // body is NOT lowercased
    input.timestamp.toLowerCase(),
  ].join('\n');
  const signature = createHmac('sha256', input.secret).update(stringToSign, 'utf8').digest('base64');
  return `SignalVine ${input.token}:${signature}`;
}

export class SignalVineAdapter implements Adapter {
  private readonly token: string;
  private readonly secret: string;
  private readonly accountId: string;

  constructor(public readonly system: SystemRow, creds: Record<string, string>) {
    this.token = creds.token ?? '';
    this.secret = creds.secret ?? '';
    this.accountId = creds.account_id ?? '';
  }

  get canDiscoverTopology(): boolean {
    return this.system.can_discover_topology;
  }

  /** Signed request. `path` must exclude the host and query string for signing. */
  private async req(method: string, path: string, query = '', body?: unknown): Promise<HttpResult> {
    const timestamp = new Date().toISOString();          // ISO-8601, ms precision
    const bodyStr = body ? JSON.stringify(body) : '';
    const auth = signalVineAuth({ token: this.token, secret: this.secret, verb: method, path, body: bodyStr, timestamp });
    const res = await fetch(API_BASE + path + query, {
      method,
      headers: {
        Authorization: auth,
        'SignalVine-Date': timestamp,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: bodyStr } : {}),
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    return { status: res.status, ok: res.ok, json, text };
  }

  async probe(): Promise<{ ok: boolean; detail: string }> {
    if (!this.token || !this.secret) return { ok: false, detail: 'token and secret required' };
    if (!this.accountId) return { ok: false, detail: 'account_id required' };
    try {
      const r = await this.req('GET', `/v1/accounts/${encodeURIComponent(this.accountId)}`);
      if (r.ok) return { ok: true, detail: 'authenticated with Modern Campus Message' };
      if (r.status === 401) return { ok: false, detail: 'signature rejected (401) — check token/secret and host clock skew (signatures valid 90s)' };
      return { ok: false, detail: `Modern Campus returned ${r.status}` };
    } catch (e: any) {
      return { ok: false, detail: `unreachable: ${e.message}` };
    }
  }

  /**
   * Withhold-only: no cheap per-identity read (a lookup fans out across every
   * program), so observe returns 'none' and enforcement relies on pollOptOuts +
   * withholding — matching the other pattern-B adapters (e.g. Telesign).
   */
  async observe(_phone: string): Promise<'opted_in' | 'opted_out' | 'none'> {
    return 'none';
  }

  async write(_phone: string, direction: Direction, _syncOriginKey: string): Promise<WriteResult> {
    const cap = direction === 'opt_out' ? this.system.can_write_optout : this.system.can_write_optin;
    if (!cap) {
      return { ok: false, reason: `system ${this.system.id} does not accept hub ${direction} writes (withhold-only; active-flag write via /participants is unconfirmed)` };
    }
    // Reached only if an operator flips the capability on before the vendor
    // confirms the active-flag write actually withholds sends. Refuse rather
    // than issue an unverified write that could read as "suppressed" wrongly.
    return { ok: false, reason: 'Modern Campus write path not yet enabled (pending vendor confirmation of active-flag write)' };
  }

  async consumerAction(): Promise<void> {
    throw new Error('consumerAction is not supported on a live Modern Campus adapter (opt-outs arrive by polling)');
  }

  async discoverTopology(): Promise<DiscoveredNode[]> {
    // Programs (pools) + groups (codes) could feed topology attribution later;
    // not enabled by default for this withhold-only integration.
    return [];
  }

  /**
   * Pull the current opted-out set per program. The contacts endpoint has no
   * documented "changed since" filter, so we re-pull the inactive set each run;
   * re-reporting an existing opt-out is idempotent in ingest. `sinceIso` is
   * accepted for the contract but reserved until a delta filter is confirmed.
   */
  async pollOptOuts(_sinceIso: string | null): Promise<PolledEvent[]> {
    const programs = await this.listProgramIds();
    const events: PolledEvent[] = [];
    for (const pid of programs) {
      let start: string | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const query = `?active=false&count=${PAGE}` + (start ? `&start=${encodeURIComponent(start)}` : '');
        const r = await this.req('GET', `/v2/programs/${encodeURIComponent(pid)}/contacts`, query);
        if (!r.ok) throw new Error(`Modern Campus contacts poll (program ${pid}) returned ${r.status}`);
        const mapped = mapInactiveContacts(r.json);
        // Validation aid (UNPROVEN mapping): if the page carried inactive contacts
        // but we extracted no phone from any of them, the guessed field names in
        // extractPhone don't match this account's payload — warn loudly rather than
        // silently returning zero opt-outs. Log one sample's keys to speed the fix.
        const rowCount = Array.isArray(r.json?.items) ? r.json.items.length : 0;
        if (rowCount > 0 && mapped.length === 0) {
          log.warn('signal_vine_no_phone_extracted', {
            system: this.system.id, program: pid, contacts_on_page: rowCount,
            hint: 'extractPhone found no phone — verify the contact field mapping against the live payload',
            sample_keys: sampleContactKeys(r.json),
          });
        }
        events.push(...mapped);
        start = nextPageStart(r.json);
        if (!start) break;
      }
    }
    return events;
  }

  /** Enumerate program IDs under the account (v1 offset paging; programs are few). */
  private async listProgramIds(): Promise<string[]> {
    const r = await this.req('GET', `/v1/accounts/${encodeURIComponent(this.accountId)}/programs`, `?count=${PAGE}`);
    if (!r.ok) throw new Error(`Modern Campus programs list returned ${r.status}`);
    return mapProgramIds(r.json);
  }
}

// ---- Pure mappers (exported for tests) --------------------------------------
//
// The OpenAPI spec does not schematize response bodies, so these encode a
// best-guess shape and MUST be verified against a live payload before go-live.
// They read the documented paging envelopes (v1 `items`/offset, v2 `items`/`next`)
// and pull a phone + opt-out timestamp from each contact defensively.

/** Program IDs from GET /v1/accounts/{id}/programs (`items[].id`). */
export function mapProgramIds(json: any): string[] {
  const items = json?.items;
  if (!Array.isArray(items)) return [];
  return items.map((p: any) => p?.id).filter((id: any) => id != null).map(String);
}

/** Keyset cursor for the next page of a v2 collection, or null when exhausted. */
export function nextPageStart(json: any): string | null {
  const next = json?.next;
  return next === null || next === undefined || next === '' ? null : String(next);
}

/**
 * Map a v2 contacts page (`active=false`) to opt-out events. Each inactive
 * contact becomes an `opt_out` for its phone. Phone and timestamp field names
 * are not in the spec — extracted defensively and flagged for verification.
 */
export function mapInactiveContacts(json: any): PolledEvent[] {
  const items = json?.items;
  if (!Array.isArray(items)) return [];
  const events: PolledEvent[] = [];
  for (const c of items) {
    const phone = extractPhone(c);
    if (!phone) continue;
    events.push({ identity_value: phone, direction: 'opt_out', occurred_at: extractTimestamp(c) });
  }
  return events;
}

/**
 * Field names (not values) present on the first contact of a page, incl. one
 * level of nesting — a PII-safe breadcrumb for correcting the phone/timestamp
 * mapping during live validation. Returns e.g. ["id","profile.mobilePhone",…].
 */
export function sampleContactKeys(json: any): string[] {
  const c = Array.isArray(json?.items) ? json.items[0] : null;
  if (!c || typeof c !== 'object') return [];
  const keys: string[] = [];
  for (const [k, v] of Object.entries(c)) {
    keys.push(k);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const nk of Object.keys(v as object)) keys.push(`${k}.${nk}`);
    }
  }
  return keys;
}

/** Best-guess phone extraction: top-level or nested profile/fields object. */
export function extractPhone(contact: any): string | null {
  if (!contact || typeof contact !== 'object') return null;
  const KEYS = ['phone', 'Phone', 'mobile', 'Mobile', 'cell', 'phone_number', 'phoneNumber'];
  const nests = [contact, contact.profile, contact.fields, contact.data];
  for (const obj of nests) {
    if (!obj || typeof obj !== 'object') continue;
    for (const k of KEYS) {
      const v = obj[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  return null;
}

/** Best-guess opt-out timestamp; falls back to now when the platform omits one. */
export function extractTimestamp(contact: any): Date {
  const KEYS = ['updated_at', 'updatedAt', 'opted_out_at', 'modified', 'last_updated'];
  for (const k of KEYS) {
    const v = contact?.[k];
    if (typeof v === 'string') {
      const d = new Date(v);
      if (!isNaN(d.getTime())) return d;
    }
  }
  return new Date();
}
