import test from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemoryRateLimitStore, setRateLimitStore, getRateLimitStore, requireRateLimit,
  _resetBuckets, type RateLimitStore,
} from '../src/auth/ratelimit.js';
import { RedisRateLimitStore } from '../src/auth/ratelimit-redis.js';

// A tiny Express-ish response capturing status/headers/body.
function fakeRes() {
  return {
    statusCode: 0, headers: {} as Record<string, string>, body: undefined as any,
    setHeader(k: string, v: string) { this.headers[k] = v; },
    status(c: number) { this.statusCode = c; return this; },
    json(b: any) { this.body = b; return this; },
  };
}
const apiKey = (over: Record<string, unknown> = {}) =>
  ({ id: 7, system_id: 's1', rate_limit_per_sec: null, ...over });

test('InMemoryRateLimitStore delegates to the token bucket', async () => {
  _resetBuckets();
  const store = new InMemoryRateLimitStore();
  const first = await store.consume(1, 2);   // fresh bucket of 2 → allowed
  assert.equal(first.ok, true);
  await store.consume(1, 2);                 // second token
  const blocked = await store.consume(1, 2); // drained
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfterSec >= 1);
});

test('setRateLimitStore / getRateLimitStore swap the active store', () => {
  const custom: RateLimitStore = { consume: async () => ({ ok: true, retryAfterSec: 0 }) };
  const original = getRateLimitStore();
  setRateLimitStore(custom);
  assert.equal(getRateLimitStore(), custom);
  setRateLimitStore(original);
});

test('RedisRateLimitStore parses the Lua result and passes key + args', async () => {
  let seen: any;
  const client = { eval: async (_lua: string, opts: any) => { seen = opts; return [1, 0]; } };
  const store = new RedisRateLimitStore(client, () => 1234);
  const d = await store.consume(42, 60);
  assert.deepEqual(d, { ok: true, retryAfterSec: 0 });
  assert.deepEqual(seen.keys, ['ratelimit:42']);
  assert.deepEqual(seen.arguments, ['60', '1234']);

  const blocked = new RedisRateLimitStore({ eval: async () => [0, 3] });
  assert.deepEqual(await blocked.consume(1, 60), { ok: false, retryAfterSec: 3 });
});

// --- middleware behaviour across stores --------------------------------------

test('a limiting store yields 429 with Retry-After; next is not called', async () => {
  setRateLimitStore({ consume: async () => ({ ok: false, retryAfterSec: 5 }) });
  const res = fakeRes();
  let nexted = false;
  await requireRateLimit(60)({ apiKey: apiKey() } as any, res as any, () => { nexted = true; });
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers['Retry-After'], '5');
  setRateLimitStore(new InMemoryRateLimitStore());
});

test('a store error fails OPEN — the request is allowed through', async () => {
  setRateLimitStore({ consume: async () => { throw new Error('redis down'); } });
  let nexted = false;
  const res = fakeRes();
  await requireRateLimit(60)({ apiKey: apiKey() } as any, res as any, () => { nexted = true; });
  assert.equal(nexted, true);
  assert.equal(res.statusCode, 0); // never responded with an error
  setRateLimitStore(new InMemoryRateLimitStore());
});

test('rate 0 disables limiting for that key (store never consulted)', async () => {
  let consulted = false;
  setRateLimitStore({ consume: async () => { consulted = true; return { ok: false, retryAfterSec: 9 }; } });
  let nexted = false;
  await requireRateLimit(60)({ apiKey: apiKey({ rate_limit_per_sec: 0 }) } as any, fakeRes() as any, () => { nexted = true; });
  assert.equal(nexted, true);
  assert.equal(consulted, false);
  setRateLimitStore(new InMemoryRateLimitStore());
});
