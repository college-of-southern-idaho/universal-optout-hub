/**
 * HTTP-level integration: drive real Express routes (middleware, machine auth,
 * JSON handling) against an ephemeral listener. Imports `app` with HUB_NO_LISTEN
 * so server.ts does NOT bind the real port or start the scheduler.
 */
process.env.HUB_NO_LISTEN = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { skipUnlessDb, setup, reset, seedSystem } from './harness.js';
import { ingest } from '../../src/services/ingest.js';
import { createApiKey } from '../../src/auth/apikeys.js';

const opts = await skipUnlessDb();
let base = '';
let close: (() => Promise<void>) | null = null;

if (!('skip' in opts)) {
  await setup();
  const { app } = await import('../../src/api/server.js');
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
  close = () => new Promise<void>((resolve) => server.close(() => resolve()));
}

test.after(async () => { if (close) await close(); });

test('GET /readyz reports the service healthy', opts, async () => {
  const res = await fetch(`${base}/readyz`);
  assert.equal(res.status, 200);
  const body: any = await res.json();
  assert.equal(body.status, 'ready');
});

test('POST /api/v1/consent/check requires a valid API key', opts, async () => {
  await reset();
  await seedSystem({ id: 'sender', channel: 'sms', category: 'marketing' });

  const noKey = await fetch(`${base}/api/v1/consent/check`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ system: 'sender', channel: 'sms', identities: ['+12085550150'] }),
  });
  assert.equal(noKey.status, 401);   // machine auth is mandatory

  const badKey = await fetch(`${base}/api/v1/consent/check`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'oohk_not-a-real-key' },
    body: JSON.stringify({ system: 'sender', channel: 'sms', identities: ['+12085550150'] }),
  });
  assert.equal(badKey.status, 401);
});

test('POST /api/v1/consent/check returns the decision for a keyed request', opts, async () => {
  await reset();
  await seedSystem({ id: 'sender', channel: 'sms', category: 'marketing' });
  await ingest({ system_id: 'sender', identity_value: '+12085550151', direction: 'opt_out', source_detail: 'STOP' });
  const { plaintext } = await createApiKey('sender', 'test key', 'tester');

  const res = await fetch(`${base}/api/v1/consent/check`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': plaintext },
    body: JSON.stringify({ system: 'sender', channel: 'sms', identities: ['+12085550151', '+12085550152'] }),
  });
  assert.equal(res.status, 200);
  const body: any = await res.json();
  const byNorm = Object.fromEntries(body.results.map((r: any) => [r.normalized, r]));
  assert.equal(byNorm['+12085550151'].decision, 'suppress');   // known opt-out
  assert.equal(byNorm['+12085550152'].decision, 'allow');      // unknown → blocklist default sends
});

test('POST /api/v1/consent/check rejects a key scoped to another system (403)', opts, async () => {
  await reset();
  await seedSystem({ id: 'sender', channel: 'sms', category: 'marketing' });
  await seedSystem({ id: 'other', channel: 'sms', category: 'marketing' });
  const { plaintext } = await createApiKey('other', 'other key', 'tester');

  const res = await fetch(`${base}/api/v1/consent/check`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': plaintext },
    body: JSON.stringify({ system: 'sender', channel: 'sms', identities: ['+12085550153'] }),
  });
  assert.equal(res.status, 403);
});
