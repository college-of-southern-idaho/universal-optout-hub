import { signAwsV4, amzDateNow } from './awssig.js';
import type { Adapter, WriteResult } from './contract.js';
import type { Direction, DiscoveredNode, SystemRow } from '../core/types.js';

/**
 * Amazon SES (email) adapter — a live client over the SESv2 account-level
 * suppression list, which is a full read/write surface (unlike SNS SMS):
 *   - probe          → GET /v2/email/account (authenticate)
 *   - observe        → GET /v2/email/suppression/addresses/{email}
 *                      (200 = suppressed → opted_out; 404 = not on list → none)
 *   - write(opt_out) → PUT /v2/email/suppression/addresses {EmailAddress, Reason}
 *                      Reason is COMPLAINT (the "they don't want mail" case; SES
 *                      only accepts BOUNCE | COMPLAINT for manual additions).
 *   - write(opt_in)  → DELETE /v2/email/suppression/addresses/{email}
 *                      (removing from the suppression list re-enables sending)
 *   - discoverTopology → none (SES suppression has no list/group structure)
 *
 * SESv2 is a JSON REST API signed with SigV4 (see awssig.ts). Endpoint:
 * email.<region>.amazonaws.com, service 'ses'.
 */
export class AmazonSesAdapter implements Adapter {
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  private readonly region: string;
  private readonly service = 'ses';

  constructor(public readonly system: SystemRow, creds: Record<string, string>) {
    this.accessKeyId = creds.access_key_id ?? '';
    this.secretAccessKey = creds.secret_access_key ?? '';
    this.region = creds.region ?? '';
  }

  get canDiscoverTopology(): boolean {
    return false;
  }

  private get host(): string {
    return `email.${this.region}.amazonaws.com`;
  }

  /** Sign and send one SESv2 REST call. `body` is '' for GET/DELETE. */
  private async call(method: string, path: string, body = ''): Promise<{ status: number; ok: boolean; text: string }> {
    const amzDate = amzDateNow();
    const headers: Record<string, string> = body ? { 'content-type': 'application/json' } : {};
    const { authorization } = signAwsV4({
      method, host: this.host, region: this.region, service: this.service,
      path, body, accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey, amzDate, headers,
    });
    const res = await fetch(`https://${this.host}${path}`, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), 'X-Amz-Date': amzDate, Authorization: authorization },
      body: body || undefined,
    });
    return { status: res.status, ok: res.ok, text: await res.text() };
  }

  private addressPath(email: string): string {
    return `/v2/email/suppression/addresses/${encodeURIComponent(email)}`;
  }

  async probe(): Promise<{ ok: boolean; detail: string }> {
    if (!this.accessKeyId || !this.secretAccessKey || !this.region) {
      return { ok: false, detail: 'access_key_id, secret_access_key and region are required' };
    }
    try {
      const r = await this.call('GET', '/v2/email/account');
      if (r.ok) return { ok: true, detail: `authenticated to SES in ${this.region}` };
      if (r.status === 403) return { ok: false, detail: 'access denied — check the IAM keys/permissions (403)' };
      return { ok: false, detail: sesError(r.text) ?? `SES returned ${r.status}` };
    } catch (e: any) {
      return { ok: false, detail: `unreachable: ${e.message}` };
    }
  }

  async observe(email: string): Promise<'opted_in' | 'opted_out' | 'none'> {
    const r = await this.call('GET', this.addressPath(email));
    if (r.status === 404) return 'none';       // not on the suppression list
    if (r.ok) return 'opted_out';              // suppressed
    return 'none';                             // error → unknown
  }

  async write(email: string, direction: Direction, syncOriginKey: string): Promise<WriteResult> {
    void syncOriginKey;
    const cap = direction === 'opt_out' ? this.system.can_write_optout : this.system.can_write_optin;
    if (!cap) {
      return { ok: false, reason: `system ${this.system.id} does not accept hub ${direction} writes` };
    }
    const r = direction === 'opt_out'
      ? await this.call('PUT', '/v2/email/suppression/addresses', JSON.stringify({ EmailAddress: email, Reason: 'COMPLAINT' }))
      : await this.call('DELETE', this.addressPath(email));
    // DELETE of an address that isn't suppressed returns 404 — the desired
    // end-state (not suppressed) already holds, so treat it as success.
    if (r.ok || (direction === 'opt_in' && r.status === 404)) return { ok: true };
    return { ok: false, reason: sesError(r.text) ?? `SES returned ${r.status}` };
  }

  async consumerAction(): Promise<void> {
    throw new Error('consumerAction is not supported on a live Amazon SES adapter');
  }

  async discoverTopology(): Promise<DiscoveredNode[]> {
    return [];
  }
}

/** Pure: pull an SESv2 JSON error message into a readable string, or null. */
export function sesError(body: string): string | null {
  try {
    const j = JSON.parse(body);
    const msg = j?.message ?? j?.Message;
    return typeof msg === 'string' && msg ? msg : null;
  } catch {
    return null;
  }
}
