import type { Adapter, WriteResult } from './contract.js';
import type { Direction, DiscoveredNode, SystemRow } from '../core/types.js';

/**
 * SendGrid (Twilio SendGrid) adapter — the first real client.
 *
 * Maps the hub contract onto SendGrid's v3 API:
 *   discoverTopology → GET /asm/groups        (unsubscribe/suppression groups)
 *   observe          → GET /asm/suppressions/global/{email}  (globally suppressed?)
 *   write opt_out    → POST /asm/suppressions/global         (global unsubscribe)
 *   write opt_in     → DELETE /asm/suppressions/global/{email} (lift suppression)
 *   probe            → GET /scopes             (authenticate the API key)
 *
 * SendGrid has no positive opt-in record, so observe returns 'opted_out' | 'none'
 * (never 'opted_in'): absence of suppression means "sendable", not consent.
 *
 * SendGrid does not reflect a caller-supplied key on its writes, so write()
 * returns ok WITHOUT a PlatformEcho. Real-time confirmation instead arrives via
 * SendGrid's Event Webhook (group_unsubscribe / unsubscribe events), which a
 * future inbound route feeds through ingest — out of scope for this adapter.
 */
export class SendGridAdapter implements Adapter {
  private readonly base = 'https://api.sendgrid.com/v3';
  private readonly apiKey: string;

  constructor(public readonly system: SystemRow, creds: Record<string, string>) {
    this.apiKey = creds.api_key ?? '';
  }

  get canDiscoverTopology(): boolean {
    return this.system.can_discover_topology;
  }

  private async req(method: string, path: string, body?: unknown): Promise<{ status: number; ok: boolean; json: any; text: string }> {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    return { status: res.status, ok: res.ok, json, text };
  }

  async probe(): Promise<{ ok: boolean; detail: string }> {
    if (!this.apiKey) return { ok: false, detail: 'no api_key configured' };
    try {
      const r = await this.req('GET', '/scopes');
      if (r.ok) return { ok: true, detail: 'authenticated with SendGrid' };
      if (r.status === 401) return { ok: false, detail: 'invalid API key (401)' };
      return { ok: false, detail: `SendGrid returned ${r.status}` };
    } catch (e: any) {
      return { ok: false, detail: `unreachable: ${e.message}` };
    }
  }

  async discoverTopology(): Promise<DiscoveredNode[]> {
    if (!this.system.can_discover_topology) return [];
    const r = await this.req('GET', '/asm/groups');
    if (!r.ok) throw new Error(`SendGrid /asm/groups returned ${r.status}`);
    return mapSendGridGroups(r.json);
  }

  async observe(email: string): Promise<'opted_in' | 'opted_out' | 'none'> {
    // 200 with a recipient_email ⇒ globally suppressed; 404 ⇒ not suppressed.
    const r = await this.req('GET', `/asm/suppressions/global/${encodeURIComponent(email)}`);
    if (r.ok && r.json && r.json.recipient_email) return 'opted_out';
    return 'none';
  }

  async write(email: string, direction: Direction, syncOriginKey: string): Promise<WriteResult> {
    void syncOriginKey; // SendGrid does not echo a caller key; see class comment.
    const cap = direction === 'opt_out' ? this.system.can_write_optout : this.system.can_write_optin;
    if (!cap) {
      return { ok: false, reason: `system ${this.system.id} does not accept hub ${direction} writes` };
    }
    try {
      if (direction === 'opt_out') {
        const r = await this.req('POST', '/asm/suppressions/global', { recipient_emails: [email] });
        return r.ok ? { ok: true } : { ok: false, reason: `SendGrid ${r.status}: ${r.text.slice(0, 200)}` };
      }
      const r = await this.req('DELETE', `/asm/suppressions/global/${encodeURIComponent(email)}`);
      return r.ok ? { ok: true } : { ok: false, reason: `SendGrid ${r.status}: ${r.text.slice(0, 200)}` };
    } catch (e: any) {
      return { ok: false, reason: `SendGrid unreachable: ${e.message}` };
    }
  }

  async consumerAction(): Promise<void> {
    // A real consumer unsubscribe arrives via SendGrid's Event Webhook, not here.
    throw new Error('consumerAction is not supported on a live SendGrid adapter (events arrive by webhook)');
  }
}

/** Pure: map SendGrid /asm/groups output to topology nodes. Exported for testing. */
export function mapSendGridGroups(raw: unknown): DiscoveredNode[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((g): g is { id: number | string; name?: string } => !!g && (typeof g === 'object') && 'id' in g)
    .map((g) => ({
      kind: 'group' as const,
      external_ref: String(g.id),
      label: g.name ?? null,
      parent_ref: null,
    }));
}
