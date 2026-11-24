import { pool } from '../db.js';
import type { DiscoveredNode, Direction, SystemRow } from '../core/types.js';
import type { Adapter, PlatformEcho, WriteResult } from './contract.js';

/**
 * Mock adapter (DESIGN.md §9). Simulates a platform by reading and writing the
 * `platform_records` table, and returns an "echo" payload — the webhook the
 * real platform would fire back after accepting a write. The caller feeds that
 * echo through ingest, which recognizes it via sync_origin_key rather than
 * treating it as a new consumer event (§8.2). Backs every system that has no
 * real adapter client, or whose credentials are not configured yet.
 */
export class MockAdapter implements Adapter {
  constructor(public readonly system: SystemRow) {}

  /** What the platform currently believes about this identity. */
  async observe(identityValue: string): Promise<'opted_in' | 'opted_out' | 'none'> {
    const r = await pool.query(
      'SELECT status FROM platform_records WHERE system_id=$1 AND identity_value=$2',
      [this.system.id, identityValue],
    );
    return r.rows[0]?.status ?? 'none';
  }

  /** Hub-originated corrective write. Honors the capability flags. */
  async write(
    identityValue: string,
    direction: Direction,
    syncOriginKey: string,
  ): Promise<WriteResult> {
    const cap =
      direction === 'opt_out' ? this.system.can_write_optout : this.system.can_write_optin;
    if (!cap) {
      return { ok: false, reason: `system ${this.system.id} does not accept hub ${direction} writes` };
    }
    const status = direction === 'opt_in' ? 'opted_in' : 'opted_out';
    await pool.query(
      `INSERT INTO platform_records (system_id, identity_value, status, updated_at)
       VALUES ($1,$2,$3,now())
       ON CONFLICT (system_id, identity_value)
       DO UPDATE SET status=$3, updated_at=now()`,
      [this.system.id, identityValue, status],
    );
    // The platform "fires its webhook" reporting the change we just made.
    return {
      ok: true,
      echo: {
        system_id: this.system.id,
        identity_value: identityValue,
        direction,
        sync_origin_key: syncOriginKey,
        occurred_at: new Date(),
      },
    };
  }

  /**
   * Simulate a consumer acting directly on the platform (texting STOP/START,
   * clicking unsubscribe). The platform updates its own record first, then
   * emits the event the hub will ingest.
   */
  async consumerAction(identityValue: string, direction: Direction): Promise<void> {
    const status = direction === 'opt_in' ? 'opted_in' : 'opted_out';
    await pool.query(
      `INSERT INTO platform_records (system_id, identity_value, status, updated_at)
       VALUES ($1,$2,$3,now())
       ON CONFLICT (system_id, identity_value)
       DO UPDATE SET status=$3, updated_at=now()`,
      [this.system.id, identityValue, status],
    );
  }

  /** Whether this adapter can discover its own topology (ADR-0002 §2.3). */
  get canDiscoverTopology(): boolean {
    return this.system.can_discover_topology;
  }

  /**
   * Lightweight connectivity probe for the service-config "Test connection"
   * step. A production adapter would authenticate against the real platform
   * with its stored credentials; the mock confirms its backing store is
   * reachable. Never touches consent state.
   */
  async probe(): Promise<{ ok: boolean; detail: string }> {
    try {
      await pool.query('SELECT 1');
      return { ok: true, detail: 'mock adapter reachable' };
    } catch (e: any) {
      return { ok: false, detail: e.message };
    }
  }

  /**
   * Discover the service's current pools/groups/codes (ADR-0002 §2.1, §5).
   * A production adapter calls the service API — Twilio Messaging Services /
   * sender pools, Telesign provisioned numbers, Constant Contact lists. The
   * mock reads the simulated `platform_topology` table. Returns [] for
   * services that cannot report groupings (they rely on manual annotation).
   */
  async discoverTopology(): Promise<DiscoveredNode[]> {
    if (!this.system.can_discover_topology) return [];
    const r = await pool.query<DiscoveredNode>(
      `SELECT kind, external_ref, label, parent_ref
         FROM platform_topology WHERE system_id=$1
        ORDER BY kind, external_ref`,
      [this.system.id],
    );
    return r.rows;
  }
}


