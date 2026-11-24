import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSecret, requireSecret } from '../src/core/config.js';

// Secret resolution: file (${NAME}_FILE) takes precedence over env (${NAME}).

test('readSecret returns the env value when only the var is set', () => {
  assert.equal(readSecret('APP_SECRET', { APP_SECRET: 'from-env' }), 'from-env');
  assert.equal(readSecret('APP_SECRET', {}), undefined);
  assert.equal(readSecret('APP_SECRET', { APP_SECRET: '' }), undefined); // empty is "unset"
});

test('readSecret reads from a mounted file and strips a trailing newline; file wins over env', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sec-'));
  const file = join(dir, 'app_secret');
  writeFileSync(file, 'from-file-value\n');
  assert.equal(readSecret('APP_SECRET', { APP_SECRET_FILE: file }), 'from-file-value');
  assert.equal(readSecret('APP_SECRET', { APP_SECRET_FILE: file, APP_SECRET: 'from-env' }), 'from-file-value');
});

test('readSecret throws a clear error when the _FILE path is unreadable', () => {
  assert.throws(
    () => readSecret('APP_SECRET', { APP_SECRET_FILE: '/no/such/secret/file' }),
    /APP_SECRET_FILE.*could not be read/,
  );
});

// requireSecret: production is strict; dev falls back with a warning.

test('in production a missing / weak / forbidden secret refuses to boot', () => {
  const prod = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;
  assert.throws(() => requireSecret('APP_SECRET', { minLength: 16 }, prod), /required in production/);
  assert.throws(
    () => requireSecret('APP_SECRET', { minLength: 16 }, { ...prod, APP_SECRET: 'short' }),
    /at least 16 characters/,
  );
  assert.throws(
    () => requireSecret('APP_SECRET', { forbid: ['dev-default'] }, { ...prod, APP_SECRET: 'dev-default' }),
    /must not be an insecure default/,
  );
});

test('in production a strong secret is accepted', () => {
  const v = requireSecret('APP_SECRET', { minLength: 16 }, { NODE_ENV: 'production', APP_SECRET: 'a-sufficiently-long-secret' });
  assert.equal(v, 'a-sufficiently-long-secret');
});

test('outside production, the dev fallback is used when unset', () => {
  const v = requireSecret('APP_SECRET', { devFallback: 'dev-key' }, { NODE_ENV: 'test' });
  assert.equal(v, 'dev-key');
  // ...but a real value is still preferred.
  assert.equal(requireSecret('APP_SECRET', { devFallback: 'dev-key' }, { NODE_ENV: 'test', APP_SECRET: 'real' }), 'real');
});
