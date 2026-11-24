import type { Direction, DiscoveredNode, SystemRow } from '../core/types.js';

/**
 * Adapter contract (DESIGN.md §9).
 *
 * An adapter is how the hub talks to one sending service. MockAdapter simulates
 * a platform with local tables; real adapters (e.g. SendGridAdapter) call the
 * platform API with the system's stored credentials. The registry builds the
 * right one per system and falls back to the mock for types without a real
 * client yet.
 */

/**
 * The webhook a platform fires back after accepting a hub-originated write,
 * carrying our sync_origin_key so ingest recognizes it as our own echo rather
 * than a fresh consumer event (§8.2). Real platforms that do not reflect a
 * caller key omit this; the hub then relies on the platform's own event
 * webhook plus reconciliation instead.
 */
export interface PlatformEcho {
  system_id: string;
  identity_value: string;
  direction: Direction;
  sync_origin_key: string;
  occurred_at: Date;
}

export interface WriteResult {
  ok: boolean;
  reason?: string;
  echo?: PlatformEcho;
}

/**
 * A consumer consent event pulled from a poll-delivery platform (one that has
 * no inbound webhook). The poller (services/poller.ts) feeds these to ingest.
 */
export interface PolledEvent {
  identity_value: string;
  direction: Direction;
  occurred_at: Date;
}

export interface Adapter {
  readonly system: SystemRow;

  /** What the platform currently believes about this identity. */
  observe(identityValue: string): Promise<'opted_in' | 'opted_out' | 'none'>;

  /** Hub-originated corrective write. Must honor the capability flags. */
  write(identityValue: string, direction: Direction, syncOriginKey: string): Promise<WriteResult>;

  /**
   * Simulate a consumer acting directly on the platform. Meaningful only for the
   * mock; real adapters receive consumer actions via the platform's inbound
   * webhook and should reject this.
   */
  consumerAction(identityValue: string, direction: Direction): Promise<void>;

  readonly canDiscoverTopology: boolean;

  /** Authenticate / reach the platform for the "Test connection" step. */
  probe(): Promise<{ ok: boolean; detail: string }>;

  /** Discover the service's current pools/groups/codes (ADR-0002 §2.1). */
  discoverTopology(): Promise<DiscoveredNode[]>;

  /**
   * Pull consumer opt-out/opt-in events changed since `sinceIso` (null = first
   * run). Implemented only by poll-delivery adapters (no inbound webhook); the
   * poller skips adapters that don't define it. Returns events in ascending
   * occurred_at order where the platform allows it.
   */
  pollOptOuts?(sinceIso: string | null): Promise<PolledEvent[]>;

  /**
   * Point the platform's inbound consent webhook at the hub, so consumer
   * STOP/START events are delivered here automatically (ADR-0002). Optional:
   * only platforms whose inbound URL is API-configurable implement it (e.g.
   * Twilio Messaging Services). `publicUrl` is the hub's public webhook endpoint
   * for this system — it must be reachable by the platform and match the URL the
   * hub verifies signatures against (WEBHOOK_PUBLIC_BASE).
   */
  provisionInboundWebhook?(publicUrl: string): Promise<{ ok: boolean; detail: string }>;
}
