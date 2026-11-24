import type { RateLimitStore, RateLimitDecision } from './ratelimit.js';

/**
 * Shared, cross-instance rate-limit store backed by Redis (PRODUCTION-READINESS
 * §1, HA). Use this when running more than one hub instance so a key's limit is
 * enforced across all of them, not per process.
 *
 * The token bucket is applied atomically in a Lua script — the exact same
 * arithmetic as the pure `consumeToken` (which IS unit-tested), just run inside
 * Redis so concurrent instances can't race. Keys expire after 60s idle.
 *
 * `redis` is an OPTIONAL runtime dependency: it is imported dynamically and only
 * when `REDIS_URL` is set, so single-instance deployments need not install it.
 * Enable with:  npm install redis  &&  set REDIS_URL=redis://host:6379
 *
 * NOTE: the Lua arithmetic mirrors the tested core, but this Redis path itself
 * has not been exercised against a live Redis in CI — validate it against your
 * Redis before relying on it in production.
 */

// KEYS[1] = bucket key; ARGV[1] = rate (capacity & refill/sec); ARGV[2] = now(ms).
// Returns {allowed(0|1), retryAfterSec}. Mirrors consumeToken exactly.
const TOKEN_BUCKET_LUA = `
local rate = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
local d = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(d[1])
local ts = tonumber(d[2])
if tokens == nil then tokens = rate; ts = now end
local elapsed = (now - ts) / 1000
if elapsed < 0 then elapsed = 0 end
tokens = math.min(rate, tokens + elapsed * rate)
local allowed = 0
local retry = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retry = math.ceil((1 - tokens) / rate)
  if retry < 1 then retry = 1 end
end
redis.call('HMSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', KEYS[1], 60000)
return {allowed, retry}
`;

interface RedisLike {
  eval(script: string, opts: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

export class RedisRateLimitStore implements RateLimitStore {
  constructor(private readonly client: RedisLike, private readonly now: () => number = Date.now) {}

  async consume(keyId: number, ratePerSec: number): Promise<RateLimitDecision> {
    const res = (await this.client.eval(TOKEN_BUCKET_LUA, {
      keys: [`ratelimit:${keyId}`],
      arguments: [String(ratePerSec), String(this.now())],
    })) as [number, number];
    return { ok: Number(res?.[0]) === 1, retryAfterSec: Number(res?.[1] ?? 1) };
  }
}

/**
 * Connect to Redis and build the store. Dynamically imports `redis`, so a
 * deployment that doesn't set REDIS_URL never needs the package. Throws with a
 * clear message if `redis` isn't installed or the connection fails, so the
 * caller can fall back to the in-memory store.
 */
export async function createRedisRateLimitStore(url: string): Promise<RedisRateLimitStore> {
  let mod: any;
  try {
    // Non-literal specifier so the compiler doesn't require `redis` to be
    // installed — it's an optional runtime dependency, loaded only here.
    const pkg = 'redis';
    mod = await import(pkg);
  } catch {
    throw new Error('REDIS_URL is set but the "redis" package is not installed — run `npm install redis`');
  }
  const client = mod.createClient({ url });
  client.on('error', (e: any) => console.error('[ratelimit] redis error:', e.message));
  await client.connect();
  return new RedisRateLimitStore(client);
}
