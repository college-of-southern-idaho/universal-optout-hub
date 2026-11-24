import type { Adapter, WriteResult } from './contract.js';
import type { Direction, DiscoveredNode, SystemRow } from '../core/types.js';

/**
 * Telesign (Messaging) adapter — a WITHHOLD-ONLY SMS client (ADR-0002 §1).
 *
 * Telesign keeps no caller-writable suppression list: the hub cannot push
 * opt-out/opt-in state to it. Enforcement is by WITHHOLDING sends (via the
 * consent-check API for our own senders), and consumer opt-outs are learned
 * from Telesign's inbound Mobile-Originated (MO) callback — Telesign detects the
 * STOP/START/HELP keyword and posts a signed callback, which
 * POST /api/webhooks/telesign/<system> verifies and feeds to ingest.
 *
 *   probe            → authenticate (HTTP Basic customer_id:api_key)
 *   observe          → not pollable: no per-number opt-out read → 'none'
 *   write            → UNSUPPORTED (withhold-only); enforce by not sending
 *   discoverTopology → no documented bulk endpoint for sender codes → []
 *                      (annotate codes manually in the Services editor)
 *
 * NOTE: built against the documented Telesign REST/Messaging API but not yet
 * exercised against a live account — verify auth and the callback shape with a
 * Telesign sandbox before go-live.
 */
export class TelesignAdapter implements Adapter {
  private readonly base = 'https://rest-api.telesign.com';
  private readonly customerId: string;
  private readonly apiKey: string;

  constructor(public readonly system: SystemRow, creds: Record<string, string>) {
    this.customerId = creds.customer_id ?? '';
    this.apiKey = creds.api_key ?? '';
  }

  get canDiscoverTopology(): boolean {
    return this.system.can_discover_topology;
  }

  private authHeader(): string {
    return 'Basic ' + Buffer.from(`${this.customerId}:${this.apiKey}`).toString('base64');
  }

  async probe(): Promise<{ ok: boolean; detail: string }> {
    if (!this.customerId || !this.apiKey) return { ok: false, detail: 'customer_id and api_key required' };
    try {
      // Telesign is a send-oriented API with no no-op ping; a GET to the
      // messaging endpoint returns 401 for bad credentials and 4xx (e.g. 405)
      // when the credentials are accepted but the method/route isn't a read.
      const res = await fetch(`${this.base}/v1/messaging`, { headers: { Authorization: this.authHeader() } });
      if (res.status === 401 || res.status === 403) return { ok: false, detail: `invalid customer_id / api_key (${res.status})` };
      return { ok: true, detail: 'credentials accepted (full verification occurs on send/callback)' };
    } catch (e: any) {
      return { ok: false, detail: `unreachable: ${e.message}` };
    }
  }

  async observe(_phone: string): Promise<'opted_in' | 'opted_out' | 'none'> {
    void _phone; // no queryable per-number opt-out state; STOP/START arrive by callback
    return 'none';
  }

  async write(_phone: string, direction: Direction, _syncOriginKey: string): Promise<WriteResult> {
    void _phone; void _syncOriginKey;
    return {
      ok: false,
      reason: `Telesign keeps no caller-writable suppression list; enforce ${direction === 'opt_out' ? 'opt-out by withholding sends' : 're-opt-in at the sender'} (withhold-only)`,
    };
  }

  async discoverTopology(): Promise<DiscoveredNode[]> {
    // Telesign exposes no documented bulk endpoint for enumerating sender codes;
    // codes are annotated manually in the Services editor (annotate-only).
    return [];
  }

  async consumerAction(): Promise<void> {
    throw new Error('consumerAction is not supported on a live Telesign adapter (opt-outs arrive by MO callback)');
  }
}
