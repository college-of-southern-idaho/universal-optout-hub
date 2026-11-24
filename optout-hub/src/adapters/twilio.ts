import { createHash } from 'node:crypto';
import type { Adapter, WriteResult } from './contract.js';
import type { Direction, DiscoveredNode, SystemRow } from '../core/types.js';

/**
 * Twilio (Programmable Messaging) adapter — second real client.
 *
 * Twilio's opt-out model differs fundamentally from a suppression list:
 *   - probe            → GET messaging.twilio.com/v1/Services   (authenticate;
 *                        NOT /Accounts, which Standard API keys can't read)
 *   - discoverTopology → GET messaging.twilio.com/v1/Services  (sender pools),
 *                         plus each service's PhoneNumbers + ShortCodes (codes)
 *   - observe          → not pollable: Twilio's Consent API is write-only (no
 *                        per-number opt-out read), so this stays 'none'.
 *   - write            → Consent Management API bulk upsert
 *                        (POST accounts.twilio.com/v1/Consents/Bulk): pushes an
 *                        opt-out/opt-in to Twilio so it suppresses/permits sends.
 *                        Needs a sender_id (the Messaging Service SID).
 *   - provisionInboundWebhook → set the Messaging Service's inbound URL to the
 *                        hub, so consumer STOP/START (with OptOutType) is POSTed
 *                        to /api/webhooks/twilio/<system> and ingested.
 *
 * Twilio maintains its own block list — when a user texts STOP, Twilio blocks
 * future sends (Error 21610) and reports STOP/START via the inbound webhook.
 * The hub therefore treats Twilio as WITHHOLD-ONLY for opt-out: it enforces
 * opt-out by not sending, and learns of consumer opt-outs from Twilio's inbound
 * webhook (route + mapping live in webhooks.ts; auto-provisionable here). Auth
 * and topology discovery are fully live.
 */
export class TwilioAdapter implements Adapter {
  private readonly messaging = 'https://messaging.twilio.com/v1';
  private readonly consent = 'https://accounts.twilio.com/v1/Consents/Bulk';
  private readonly accountSid: string;
  private readonly auth: { user: string; pass: string } | null;
  private readonly messagingServiceSid?: string;

  constructor(public readonly system: SystemRow, creds: Record<string, string>) {
    this.accountSid = creds.account_sid ?? '';
    this.auth = twilioAuthPair(creds);
    this.messagingServiceSid = creds.messaging_service_sid || undefined;
  }

  get canDiscoverTopology(): boolean {
    return this.system.can_discover_topology;
  }

  /** The Messaging Service SID this system targets, if configured. Used to route
   *  account-level Event Streams events to the right hub system (each Messaging
   *  Service is registered as its own system with its own category). */
  get messagingServiceId(): string | undefined {
    return this.messagingServiceSid;
  }

  /** True when we have both an account context (SID for the URLs) and REST auth. */
  private get authed(): boolean {
    return !!this.accountSid && !!this.auth;
  }

  /** Which credential set the REST calls are using — for clear error messages. */
  private get authMethod(): string {
    if (!this.auth) return 'no credentials';
    return this.auth.user.startsWith('SK') ? `API Key ${this.auth.user}` : 'Account SID + Auth Token';
  }

  private authHeader(): string {
    const { user, pass } = this.auth ?? { user: '', pass: '' };
    return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  }

  private async req(url: string): Promise<{ status: number; ok: boolean; json: any; text: string }> {
    const res = await fetch(url, { headers: { Authorization: this.authHeader() } });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    return { status: res.status, ok: res.ok, json, text };
  }

  async probe(): Promise<{ ok: boolean; detail: string }> {
    if (!this.authed) return { ok: false, detail: 'account_sid plus an API key (api_key_sid + api_key_secret) or auth_token are required' };
    try {
      // Authenticate against Messaging Services — NOT /Accounts, which a Standard
      // API Key cannot read (Twilio: Standard keys can't access /Accounts). This
      // is also the surface discovery + the Consent API rely on.
      const r = await this.req(`${this.messaging}/Services?PageSize=1`);
      if (r.ok) return { ok: true, detail: `authenticated via ${this.authMethod}` };
      if (r.status === 401) return { ok: false, detail: `credentials rejected (401) — using ${this.authMethod}; verify the SID/secret and that they belong to this account` };
      return { ok: false, detail: `Twilio returned ${r.status} (using ${this.authMethod})` };
    } catch (e: any) {
      return { ok: false, detail: `unreachable: ${e.message}` };
    }
  }

  async discoverTopology(): Promise<DiscoveredNode[]> {
    if (!this.system.can_discover_topology) return [];
    // Sender pools = Messaging Services; codes = the phone numbers and short
    // codes attached to each service (parent_ref = the service sid, so they nest
    // under their pool). Scope to one service if messaging_service_sid is set.
    const services = this.messagingServiceSid
      ? await this.fetchService(this.messagingServiceSid)
      : await this.listAll(`${this.messaging}/Services`, 'services');
    const nodes: DiscoveredNode[] = mapTwilioServices(services);
    for (const svc of services) {
      const sid = String((svc as { sid?: unknown }).sid ?? '');
      if (!sid) continue;
      const base = `${this.messaging}/Services/${encodeURIComponent(sid)}`;
      nodes.push(...mapTwilioPhoneNumbers(await this.listAll(`${base}/PhoneNumbers`, 'phone_numbers'), sid));
      nodes.push(...mapTwilioShortCodes(await this.listAll(`${base}/ShortCodes`, 'short_codes'), sid));
    }
    return nodes;
  }

  private async fetchService(sid: string): Promise<any[]> {
    const r = await this.req(`${this.messaging}/Services/${encodeURIComponent(sid)}`);
    if (!r.ok) throw new Error(`Twilio Messaging Service fetch returned ${r.status}`);
    return r.json ? [r.json] : [];
  }

  // Collect one list key across Twilio's pages, following meta.next_page_url.
  private async listAll(url: string, key: string): Promise<any[]> {
    const out: any[] = [];
    let next: string | null = `${url}${url.includes('?') ? '&' : '?'}PageSize=200`;
    for (let guard = 0; next && guard < 50; guard++) {
      const r = await this.req(next);
      if (!r.ok) throw new Error(`Twilio ${key} list returned ${r.status}`);
      const arr = r.json?.[key];
      if (Array.isArray(arr)) out.push(...arr);
      next = r.json?.meta?.next_page_url ?? null;
    }
    return out;
  }

  async observe(_phone: string): Promise<'opted_in' | 'opted_out' | 'none'> {
    // Twilio exposes no queryable per-number opt-out state; STOP/START arrive via
    // the inbound webhook. Nothing to poll, so report 'none' (unknown here).
    void _phone;
    return 'none';
  }

  /**
   * Push consent to Twilio via the Consent Management API (bulk upsert). This is
   * how the hub propagates an opt-out captured elsewhere TO Twilio so Twilio
   * suppresses sends — the older Advanced-Opt-Out block list had no write API.
   * Needs a sender_id (the Messaging Service SID). Write-only: there is no read
   * endpoint, so the reconciler still can't verify Twilio state (observe → none).
   */
  async write(phone: string, direction: Direction, syncOriginKey: string): Promise<WriteResult> {
    const cap = direction === 'opt_out' ? this.system.can_write_optout : this.system.can_write_optin;
    if (!cap) {
      return { ok: false, reason: `system ${this.system.id} does not accept hub ${direction} writes` };
    }
    if (!this.authed) return { ok: false, reason: 'account_sid plus an API key or auth_token are required' };
    if (!this.messagingServiceSid) {
      return { ok: false, reason: "Twilio Consent API needs a sender_id — set the Messaging Service SID credential" };
    }
    try {
      const res = await fetch(this.consent, {
        method: 'POST',
        headers: { Authorization: this.authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify(twilioConsentPayload(phone, direction, this.messagingServiceSid, syncOriginKey)),
      });
      const text = await res.text();
      let json: any = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
      if (!res.ok) {
        if (res.status === 401) return { ok: false, reason: 'invalid account_sid / auth_token (401)' };
        return { ok: false, reason: `Twilio Consent API returned ${res.status}${json?.message ? `: ${json.message}` : ''}` };
      }
      const item = json?.items?.[0];
      if (item && Number(item.error_code) === 0) return { ok: true };
      const detail = item?.error_messages?.join('; ') || `error_code ${item?.error_code ?? 'unknown'}`;
      return { ok: false, reason: `Twilio Consent API rejected the record: ${detail}` };
    } catch (e: any) {
      return { ok: false, reason: `unreachable: ${e.message}` };
    }
  }

  async consumerAction(): Promise<void> {
    throw new Error('consumerAction is not supported on a live Twilio adapter (STOP/START arrive via inbound webhook)');
  }

  /**
   * Set the Messaging Service's inbound webhook to the hub, so consumer
   * STOP/START (with Twilio's OptOutType) is POSTed here. Requires the Messaging
   * Service SID — the inbound URL is configured per Messaging Service, not per
   * account. UseInboundWebhookOnNumber=false ensures the service-level webhook
   * wins over any per-number webhook.
   */
  async provisionInboundWebhook(publicUrl: string): Promise<{ ok: boolean; detail: string }> {
    if (!this.authed) return { ok: false, detail: 'account_sid plus an API key or auth_token are required' };
    if (!this.messagingServiceSid) {
      return { ok: false, detail: 'set the Messaging Service SID — Twilio configures the inbound webhook per Messaging Service' };
    }
    try {
      const res = await fetch(`${this.messaging}/Services/${encodeURIComponent(this.messagingServiceSid)}`, {
        method: 'POST',
        headers: { Authorization: this.authHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: twilioInboundWebhookParams(publicUrl).toString(),
      });
      const text = await res.text();
      if (res.ok) return { ok: true, detail: `inbound webhook set on Messaging Service ${this.messagingServiceSid}` };
      if (res.status === 401) return { ok: false, detail: 'invalid account_sid / auth_token (401)' };
      let msg = `Twilio returned ${res.status}`;
      try { const j = JSON.parse(text); if (j?.message) msg += `: ${j.message}`; } catch { /* non-JSON body */ }
      return { ok: false, detail: msg };
    } catch (e: any) {
      return { ok: false, detail: `unreachable: ${e.message}` };
    }
  }
}

/**
 * Pure: choose the Basic-auth pair for Twilio REST calls. Prefers an API Key
 * (`SK…` + secret) — scoped and independently revocable — over the account Auth
 * Token; the Account SID still scopes the account-level URLs. Returns null when
 * neither a complete API key nor an Account SID + Auth Token is present.
 * (Webhook signature verification separately uses the Auth Token, so keep it set
 * if you use the hub's inbound Twilio webhook.) Exported for testing.
 */
export function twilioAuthPair(
  creds: { account_sid?: string; auth_token?: string; api_key_sid?: string; api_key_secret?: string },
): { user: string; pass: string } | null {
  if (creds.api_key_sid && creds.api_key_secret) return { user: creds.api_key_sid, pass: creds.api_key_secret };
  if (creds.account_sid && creds.auth_token) return { user: creds.account_sid, pass: creds.auth_token };
  return null;
}

/**
 * Pure: build the Consent Management API bulk-upsert body for one identity.
 * `correlation_id` must be a 32-char id that maps request→response; we derive a
 * deterministic one from the hub's sync_origin_key so a Twilio consent record is
 * traceable back to the hub write. Exported for testing.
 */
export function twilioConsentPayload(
  phone: string, direction: Direction, senderId: string, syncOriginKey: string,
): { Items: Array<Record<string, string>> } {
  return {
    Items: [{
      contact_id: phone,
      correlation_id: createHash('md5').update(syncOriginKey).digest('hex'), // 32 hex chars
      sender_id: senderId,
      status: direction === 'opt_out' ? 'opt-out' : 'opt-in',
      source: direction === 'opt_out' ? 'opt-out-message' : 'opt-in-message',
    }],
  };
}

/** Pure: the form body to POST to a Messaging Service to route inbound messages
 *  (including STOP/START) to `publicUrl`. Exported for testing. */
export function twilioInboundWebhookParams(publicUrl: string): URLSearchParams {
  return new URLSearchParams({
    InboundRequestUrl: publicUrl,
    InboundMethod: 'POST',
    UseInboundWebhookOnNumber: 'false',
  });
}

/** Pure: map Twilio Messaging Services to topology pool nodes. Exported for testing. */
export function mapTwilioServices(raw: unknown): DiscoveredNode[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is { sid: string; friendly_name?: string } => !!s && typeof s === 'object' && 'sid' in s)
    .map((s) => ({
      kind: 'pool' as const,
      external_ref: String(s.sid),
      label: s.friendly_name ?? null,
      parent_ref: null,
    }));
}

/** Pure: map a service's phone numbers to code nodes under that service. */
export function mapTwilioPhoneNumbers(raw: unknown, serviceSid: string): DiscoveredNode[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p): p is { phone_number?: string; sid?: string } => !!p && typeof p === 'object')
    .map((p) => ({
      kind: 'code' as const,
      external_ref: String(p.phone_number ?? p.sid ?? ''),
      label: p.phone_number ?? null,
      parent_ref: serviceSid,
    }))
    .filter((n) => n.external_ref !== '');
}

/** Pure: map a service's short codes to code nodes under that service. */
export function mapTwilioShortCodes(raw: unknown, serviceSid: string): DiscoveredNode[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is { short_code?: string; sid?: string } => !!s && typeof s === 'object')
    .map((s) => ({
      kind: 'code' as const,
      external_ref: String(s.short_code ?? s.sid ?? ''),
      label: s.short_code ?? null,
      parent_ref: serviceSid,
    }))
    .filter((n) => n.external_ref !== '');
}
