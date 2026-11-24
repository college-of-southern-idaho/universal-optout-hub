import type { Adapter, WriteResult, PolledEvent } from './contract.js';
import type { Direction, DiscoveredNode, SystemRow } from '../core/types.js';
import { storeRotatedCredential } from './credential-store.js';

/**
 * Constant Contact (v3) adapter — a writable, poll-delivery, OAuth email client.
 *
 * Maps the hub contract onto the Constant Contact v3 API
 * (https://api.cc.email/v3):
 *   probe            → GET /account/summary                 (authenticate)
 *   discoverTopology → GET /contact_lists                   (lists = groups)
 *   observe          → GET /contacts?email={email}          (permission_to_send)
 *   write opt_out    → PUT /contacts/{id} permission_to_send=unsubscribed
 *   write opt_in     → PUT /contacts/{id} permission_to_send=explicit
 *   pollOptOuts      → GET /contacts?status=unsubscribed&updated_after={cursor}
 *
 * Auth is OAuth2 bearer. Access tokens last ~24h; on a 401 the adapter refreshes
 * once via the token endpoint (HTTP Basic client_id:client_secret, grant_type=
 * refresh_token) and RE-PERSISTS the rotated access+refresh tokens (Constant
 * Contact rotates the refresh token on every refresh — losing it locks the app
 * out). Refresh needs client_secret + refresh_token; without them a 401 simply
 * surfaces as an auth error.
 *
 * Constant Contact has no inbound webhook and does not echo a caller key, so
 * write() returns ok WITHOUT a PlatformEcho; confirmation and consumer opt-outs
 * arrive through pollOptOuts (services/poller.ts), not real-time.
 *
 * NOTE: built against the documented v3 API but not yet exercised against a live
 * account — verify endpoints/fields with a Constant Contact sandbox before go-live.
 */

const API_BASE = 'https://api.cc.email/v3';
const TOKEN_URL = 'https://authz.constantcontact.com/oauth2/default/v1/token';

type Permission = 'explicit' | 'implicit' | 'pending_confirmation' | 'unsubscribed' | 'temp_hold' | 'not_set';

interface HttpResult { status: number; ok: boolean; json: any; text: string }

export class ConstantContactAdapter implements Adapter {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private accessToken: string;
  private refreshToken: string;

  constructor(public readonly system: SystemRow, creds: Record<string, string>) {
    this.clientId = creds.api_key ?? '';
    this.clientSecret = creds.client_secret ?? '';
    this.accessToken = creds.access_token ?? '';
    this.refreshToken = creds.refresh_token ?? '';
  }

  get canDiscoverTopology(): boolean {
    return this.system.can_discover_topology;
  }

  // --- HTTP with one automatic token refresh on 401 --------------------------

  private async rawReq(method: string, path: string, body?: unknown): Promise<HttpResult> {
    const res = await fetch(API_BASE + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    return { status: res.status, ok: res.ok, json, text };
  }

  private async req(method: string, path: string, body?: unknown): Promise<HttpResult> {
    let r = await this.rawReq(method, path, body);
    if (r.status === 401 && (await this.refreshAccessToken())) {
      r = await this.rawReq(method, path, body);
    }
    return r;
  }

  /**
   * Exchange the refresh token for a new access+refresh token pair and persist
   * both. Returns false (leaving the 401 to surface) when refresh isn't possible
   * or fails. Constant Contact ROTATES the refresh token — we must store the new
   * one or the next refresh fails.
   */
  private async refreshAccessToken(): Promise<boolean> {
    if (!this.clientSecret || !this.refreshToken) return false;
    try {
      const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
      // Constant Contact's Okta token endpoint requires the grant params in a
      // form-urlencoded BODY with an explicit Content-Type + Accept — sending them
      // as query params with no Content-Type gets rejected (Okta E0000021).
      const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.refreshToken });
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body,
      });
      if (!res.ok) return false;
      const tok = await res.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
      if (!tok.access_token) return false;
      this.accessToken = tok.access_token;
      const expiresAt = tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000) : null;
      await storeRotatedCredential(this.system.id, 'access_token', tok.access_token, expiresAt);
      if (tok.refresh_token) {
        this.refreshToken = tok.refresh_token;
        await storeRotatedCredential(this.system.id, 'refresh_token', tok.refresh_token, null);
      }
      return true;
    } catch {
      return false;
    }
  }

  // --- Contract --------------------------------------------------------------

  async probe(): Promise<{ ok: boolean; detail: string }> {
    if (!this.accessToken) return { ok: false, detail: 'no access_token configured' };
    try {
      const r = await this.req('GET', '/account/summary');
      if (r.ok) return { ok: true, detail: 'authenticated with Constant Contact' };
      if (r.status === 401) return { ok: false, detail: 'invalid or expired token (401) — check client_secret/refresh_token' };
      return { ok: false, detail: `Constant Contact returned ${r.status}` };
    } catch (e: any) {
      return { ok: false, detail: `unreachable: ${e.message}` };
    }
  }

  async discoverTopology(): Promise<DiscoveredNode[]> {
    if (!this.system.can_discover_topology) return [];
    const r = await this.req('GET', '/contact_lists?limit=1000');
    if (!r.ok) throw new Error(`Constant Contact /contact_lists returned ${r.status}`);
    return mapContactLists(r.json);
  }

  async observe(email: string): Promise<'opted_in' | 'opted_out' | 'none'> {
    const r = await this.req('GET', `/contacts?email=${encodeURIComponent(email)}&status=all`);
    if (!r.ok) return 'none';
    const contact = firstContact(r.json);
    return contact ? mapPermission(contact.email_address?.permission_to_send) : 'none';
  }

  async write(email: string, direction: Direction, syncOriginKey: string): Promise<WriteResult> {
    void syncOriginKey; // Constant Contact does not echo a caller key; see class comment.
    const cap = direction === 'opt_out' ? this.system.can_write_optout : this.system.can_write_optin;
    if (!cap) {
      return { ok: false, reason: `system ${this.system.id} does not accept hub ${direction} writes` };
    }
    const permission: Permission = direction === 'opt_out' ? 'unsubscribed' : 'explicit';
    try {
      const found = await this.req('GET', `/contacts?email=${encodeURIComponent(email)}&status=all`);
      if (!found.ok) return { ok: false, reason: `Constant Contact lookup ${found.status}: ${found.text.slice(0, 200)}` };
      const contact = firstContact(found.json);

      if (!contact) {
        // No contact yet: create one carrying the intended permission so the
        // suppression is recorded even for someone not previously on file.
        const r = await this.req('POST', '/contacts', {
          email_address: { address: email, permission_to_send: permission, opt_out_reason: optOutReason(direction) },
          create_source: 'Account',
        });
        return r.ok ? { ok: true } : { ok: false, reason: `Constant Contact create ${r.status}: ${r.text.slice(0, 200)}` };
      }

      // Update the existing contact, preserving its required fields and only
      // changing the permission. update_source 'Account' = hub-initiated.
      const body = {
        ...contact,
        email_address: { ...contact.email_address, address: email, permission_to_send: permission, opt_out_reason: optOutReason(direction) },
        update_source: 'Account',
      };
      const r = await this.req('PUT', `/contacts/${encodeURIComponent(contact.contact_id)}`, body);
      return r.ok ? { ok: true } : { ok: false, reason: `Constant Contact update ${r.status}: ${r.text.slice(0, 200)}` };
    } catch (e: any) {
      return { ok: false, reason: `Constant Contact unreachable: ${e.message}` };
    }
  }

  async pollOptOuts(sinceIso: string | null): Promise<PolledEvent[]> {
    const q = new URLSearchParams({ status: 'unsubscribed', limit: '500' });
    if (sinceIso) q.set('updated_after', sinceIso);
    const r = await this.req('GET', `/contacts?${q.toString()}`);
    if (!r.ok) throw new Error(`Constant Contact poll /contacts returned ${r.status}`);
    // Guard client-side on the cursor too, in case the server ignores it.
    return mapPolledUnsubscribes(r.json, sinceIso);
  }

  async consumerAction(): Promise<void> {
    throw new Error('consumerAction is not supported on a live Constant Contact adapter (opt-outs arrive by polling)');
  }
}

// ---- Pure mappers (exported for tests) --------------------------------------

/** Map a Constant Contact permission_to_send to the hub's observe result. */
export function mapPermission(permission: string | undefined): 'opted_in' | 'opted_out' | 'none' {
  if (permission === 'unsubscribed' || permission === 'temp_hold') return 'opted_out';
  if (permission === 'explicit') return 'opted_in';
  return 'none'; // implicit / pending_confirmation / not_set / missing
}

const optOutReason = (d: Direction): string =>
  d === 'opt_out' ? 'Cross-platform opt-out propagated by the consent hub' : 'Re-subscribe confirmed via consent hub';

/** First contact from a GET /contacts?email= response (`contacts` array). */
export function firstContact(json: any): { contact_id: string; email_address?: { permission_to_send?: string } } | null {
  const list = json?.contacts;
  if (Array.isArray(list) && list.length && list[0]?.contact_id) return list[0];
  return null;
}

/** Map GET /contact_lists output to topology group nodes. */
export function mapContactLists(json: any): DiscoveredNode[] {
  const lists = json?.lists;
  if (!Array.isArray(lists)) return [];
  return lists
    .filter((l: any) => l && l.list_id)
    .map((l: any) => ({
      kind: 'group' as const,
      external_ref: String(l.list_id),
      label: l.name ?? null,
      parent_ref: null,
    }));
}

/**
 * Map a GET /contacts?status=unsubscribed response to opt-out events. Only
 * contacts with a parseable updated_at (optionally newer than the cursor) are
 * emitted, sorted ascending so the poller can advance its cursor safely.
 */
export function mapPolledUnsubscribes(json: any, sinceIso: string | null): PolledEvent[] {
  const list = json?.contacts;
  if (!Array.isArray(list)) return [];
  const sinceMs = sinceIso ? Date.parse(sinceIso) : NaN;
  const out: PolledEvent[] = [];
  for (const c of list) {
    const email = c?.email_address?.address;
    const ts = c?.updated_at ?? c?.email_address?.opt_out_date;
    if (!email || !ts) continue;
    const ms = Date.parse(ts);
    if (Number.isNaN(ms)) continue;
    if (!Number.isNaN(sinceMs) && ms <= sinceMs) continue; // already ingested
    out.push({ identity_value: String(email), direction: 'opt_out', occurred_at: new Date(ms) });
  }
  out.sort((a, b) => a.occurred_at.getTime() - b.occurred_at.getTime());
  return out;
}
