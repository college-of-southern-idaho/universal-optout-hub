import test from 'node:test';
import assert from 'node:assert/strict';
import { csrfValid, requireCsrf } from '../src/auth/middleware.js';

const TOKEN = 'a'.repeat(64);

// --- pure check --------------------------------------------------------------

test('safe methods always pass, regardless of token', () => {
  for (const m of ['GET', 'HEAD', 'OPTIONS', 'get']) {
    assert.equal(csrfValid(m, undefined, undefined), true);
  }
});

test('mutating methods require a matching header token', () => {
  assert.equal(csrfValid('POST', TOKEN, TOKEN), true);
  assert.equal(csrfValid('DELETE', TOKEN, TOKEN), true);
  assert.equal(csrfValid('POST', TOKEN, 'b'.repeat(64)), false); // mismatch
  assert.equal(csrfValid('POST', TOKEN, undefined), false);       // no header
  assert.equal(csrfValid('POST', undefined, TOKEN), false);       // no session token
  assert.equal(csrfValid('POST', TOKEN, TOKEN.slice(0, 10)), false); // length differs
});

// --- middleware --------------------------------------------------------------

function run(req: any): { status: number | null; body: any; nexted: boolean } {
  let status: number | null = null, body: any = null, nexted = false;
  const res: any = { status(c: number) { status = c; return this; }, json(b: any) { body = b; return this; } };
  requireCsrf(
    { method: 'POST', header: (h: string) => req.headers?.[h.toLowerCase()], ...req } as any,
    res,
    () => { nexted = true; },
  );
  return { status, body, nexted };
}

test('no session (machine / webhook / pre-login) → skipped entirely', () => {
  const r = run({ user: undefined, csrfToken: undefined, headers: {} });
  assert.equal(r.nexted, true);
  assert.equal(r.status, null);
});

test('session request with a valid token passes', () => {
  const r = run({ user: { id: 1 }, csrfToken: TOKEN, headers: { 'x-csrf-token': TOKEN } });
  assert.equal(r.nexted, true);
});

test('session request without / with a wrong token is rejected 403', () => {
  const missing = run({ user: { id: 1 }, csrfToken: TOKEN, headers: {} });
  assert.equal(missing.nexted, false);
  assert.equal(missing.status, 403);

  const wrong = run({ user: { id: 1 }, csrfToken: TOKEN, headers: { 'x-csrf-token': 'nope' } });
  assert.equal(wrong.nexted, false);
  assert.equal(wrong.status, 403);
});
