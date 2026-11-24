/**
 * Hub-synced local suppression cache for a Class B sender (ADR-0004 §2.4/§6).
 *
 * The live per-identity check (`consent-gate.ts`) gives freshness; this cache
 * gives AVAILABILITY. A sender keeps the hub's suppression list locally and, on
 * a hub outage, falls back to it — so an outage degrades to the last-known
 * state ("who was suppressed as of the last sync") instead of a hard stop that
 * withholds every message. Over-suppression is free; the only risk this trades
 * off is missing an opt-out newer than the last successful sync, bounded by how
 * often you sync.
 *
 * Reference code to copy into your sender. No dependencies beyond `fetch`
 * (Node 20+). The cache stores NORMALIZED identities, matching the hub's
 * `value_normalized`; the gate normalizes recipients the same way before
 * looking them up (see `GateConfig.normalize`).
 */

/** One row of the hub's suppression feed (subset the client needs). */
export interface FeedEntry {
  identity: string;    // value_normalized
  suppressed: boolean; // true = withhold; false = row exists but is not suppressing
}

export interface SuppressionFeed {
  system: string;
  as_of: string;       // cursor to pass back as ?since next sync
  full: boolean;       // true = baseline snapshot; false = delta
  entries: FeedEntry[];
}

/**
 * A last-known suppression set plus its sync cursor. Pure and synchronous;
 * `applyFeed` is the only mutator, so it's trivially unit-testable.
 */
export class SuppressionCache {
  private suppressed = new Set<string>();
  private syncedOnce = false;
  cursor: string | null = null;

  /**
   * Fold a feed response into the cache. A `full` feed replaces the set (it's a
   * complete baseline); a delta adds newly-suppressed identities and removes
   * ones that are no longer suppressing (e.g. an approved re-opt-in). Advances
   * the cursor to `feed.as_of`.
   */
  applyFeed(feed: SuppressionFeed): void {
    if (feed.full) this.suppressed.clear();
    for (const e of feed.entries) {
      if (e.suppressed) this.suppressed.add(e.identity);
      else this.suppressed.delete(e.identity);
    }
    this.cursor = feed.as_of;
    this.syncedOnce = true;
  }

  /** Is this (already-normalized) identity on the last-known suppression list? */
  isSuppressed(normalizedIdentity: string): boolean {
    return this.suppressed.has(normalizedIdentity);
  }

  /**
   * Has the cache ever synced? Fallback is only safe once we hold a last-known
   * list — before the first sync there is no "last-known state", so the gate
   * must fail closed rather than trust an empty cache as "nobody suppressed".
   */
  get ready(): boolean {
    return this.syncedOnce;
  }

  get size(): number {
    return this.suppressed.size;
  }
}

/** Config for syncing the cache from the hub feed. */
export interface SyncConfig {
  hubUrl: string;
  apiKey: string;
  system: string;
  timeoutMs?: number; // default 5000
}

/**
 * Pull the feed once and fold it into `cache`. Uses the cache's cursor for an
 * incremental delta after the first (baseline) sync. Call this on a schedule
 * (e.g. every 30–60s) from your sender. Throws on any non-200 / network error /
 * timeout so the caller can log it; the cache simply keeps its last-known state.
 */
export async function syncSuppressions(cfg: SyncConfig, cache: SuppressionCache): Promise<SuppressionFeed> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? 5000);
  try {
    const url = new URL(`${cfg.hubUrl.replace(/\/+$/, '')}/api/v1/consent/suppressions`);
    url.searchParams.set('system', cfg.system);
    if (cache.cursor) url.searchParams.set('since', cache.cursor);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`suppression feed returned ${res.status}`);
    const feed = (await res.json()) as SuppressionFeed;
    cache.applyFeed(feed);
    return feed;
  } finally {
    clearTimeout(timer);
  }
}
