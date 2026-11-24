import { acsSign, rfc1123Now, parseAcsConnectionString } from './azuresig.js';
import type { Adapter, WriteResult } from './contract.js';
import type { Direction, DiscoveredNode, SystemRow } from '../core/types.js';

/**
 * Azure Communication Services (SMS) adapter — a live client over the ACS SMS
 * Opt-Out Management API, a full read/write surface scoped to a sender number:
 *   - probe          → optouts:check (read-only; authenticate)
 *   - observe        → optouts:check → value[0].isOptedOut
 *   - write(opt_out) → optouts:add
 *   - write(opt_in)  → optouts:remove
 *   - discoverTopology → none
 *
 * Auth is ACS HMAC-SHA256 (see azuresig.ts) using the resource connection
 * string's access key. Opt-outs are per (from, to) pair, so a sender number
 * (from_number) is required. Endpoint + version come from the connection string
 * and the API. (ACS also does email; this client targets the SMS opt-out list.)
 */
export class AzureCommunicationAdapter implements Adapter {
  private readonly endpoint: string;
  private readonly accessKey: string;
  private readonly host: string;
  private readonly from: string;
  private readonly valid: boolean;
  private readonly apiVersion = '2026-01-23';

  constructor(public readonly system: SystemRow, creds: Record<string, string>) {
    const parsed = parseAcsConnectionString(creds.connection_string ?? '');
    this.endpoint = parsed?.endpoint ?? '';
    this.accessKey = parsed?.accessKey ?? '';
    this.from = creds.from_number ?? '';
    let host = '';
    try { if (this.endpoint) host = new URL(this.endpoint).host; } catch { /* malformed endpoint */ }
    this.host = host;
    this.valid = !!parsed && !!host;
  }

  get canDiscoverTopology(): boolean {
    return false;
  }

  /** Sign and POST one opt-out action for a single recipient. */
  private async optOut(action: 'add' | 'remove' | 'check', to: string): Promise<{ status: number; ok: boolean; json: any }> {
    const pathAndQuery = `/sms/optouts:${action}?api-version=${this.apiVersion}`;
    const body = JSON.stringify({ from: this.from, recipients: [{ to }] });
    const date = rfc1123Now();
    const { authorization, contentHash } = acsSign({
      method: 'POST', pathAndQuery, host: this.host, body, accessKey: this.accessKey, date,
    });
    const res = await fetch(`${this.endpoint}${pathAndQuery}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ms-date': date,
        'x-ms-content-sha256': contentHash,
        Authorization: authorization,
      },
      body,
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    return { status: res.status, ok: res.ok, json };
  }

  async probe(): Promise<{ ok: boolean; detail: string }> {
    if (!this.valid) return { ok: false, detail: 'invalid or missing ACS connection string (expected endpoint=…;accesskey=…)' };
    if (!this.from) return { ok: false, detail: 'set the sender number (from_number) — ACS opt-outs are scoped to a sender' };
    try {
      const r = await this.optOut('check', this.from); // read-only self-check
      if (r.ok) return { ok: true, detail: `authenticated to ${this.host}` };
      if (r.status === 401) return { ok: false, detail: 'authentication failed (401) — check the connection string access key' };
      return { ok: false, detail: acsError(r.json) ?? `ACS returned ${r.status}` };
    } catch (e: any) {
      return { ok: false, detail: `unreachable: ${e.message}` };
    }
  }

  async observe(phone: string): Promise<'opted_in' | 'opted_out' | 'none'> {
    if (!this.valid || !this.from) return 'none';
    const r = await this.optOut('check', phone);
    if (!r.ok) return 'none';
    return r.json?.value?.[0]?.isOptedOut === true ? 'opted_out' : 'none';
  }

  async write(phone: string, direction: Direction, syncOriginKey: string): Promise<WriteResult> {
    void syncOriginKey;
    const cap = direction === 'opt_out' ? this.system.can_write_optout : this.system.can_write_optin;
    if (!cap) {
      return { ok: false, reason: `system ${this.system.id} does not accept hub ${direction} writes` };
    }
    if (!this.valid) return { ok: false, reason: 'invalid or missing ACS connection string' };
    if (!this.from) return { ok: false, reason: 'set the sender number (from_number) — ACS opt-outs are scoped to a sender' };
    const r = await this.optOut(direction === 'opt_out' ? 'add' : 'remove', phone);
    const item = r.json?.value?.[0];
    if (r.ok && Number(item?.httpStatusCode) === 200) return { ok: true };
    return { ok: false, reason: item?.errorMessage ?? acsError(r.json) ?? `ACS returned ${r.status}` };
  }

  async consumerAction(): Promise<void> {
    throw new Error('consumerAction is not supported on a live Azure Communication Services adapter');
  }

  async discoverTopology(): Promise<DiscoveredNode[]> {
    return [];
  }
}

/** Pure: pull an ACS `{ error: { code, message } }` into a readable string. */
export function acsError(json: any): string | null {
  const e = json?.error;
  if (!e) return null;
  const s = [e.code, e.message].filter(Boolean).join(': ');
  return s || null;
}
