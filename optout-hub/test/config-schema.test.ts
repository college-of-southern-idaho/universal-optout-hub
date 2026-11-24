import test from 'node:test';
import assert from 'node:assert/strict';
import { SETTING_BY_KEY, resolvedDefault, validateSetting } from '../src/core/config-schema.js';

const get = (k: string) => {
  const s = SETTING_BY_KEY.get(k);
  if (!s) throw new Error(`no setting ${k}`);
  return s;
};

// --- default resolution: env seeds, else built-in ----------------------------

test('resolvedDefault falls back to the built-in default when no env var', () => {
  delete process.env.CONSENT_CHECK_MODE;
  assert.equal(resolvedDefault(get('consentCheckMode')), 'blocklist');
  assert.equal(resolvedDefault(get('reviewTtlDays')), 10);
  assert.equal(resolvedDefault(get('defaultPhoneRegion')), 'US');
});

test('resolvedDefault uses the env value when set and valid', () => {
  process.env.CONSENT_CHECK_MODE = 'allowlist';
  process.env.CONSENT_CHECK_RATE_LIMIT_PER_SEC = '120';
  process.env.INITIATOR_CANNOT_APPROVE = '1';
  try {
    assert.equal(resolvedDefault(get('consentCheckMode')), 'allowlist');
    assert.equal(resolvedDefault(get('consentCheckRateLimitPerSec')), 120);
    assert.equal(resolvedDefault(get('initiatorCannotApprove')), true);
  } finally {
    delete process.env.CONSENT_CHECK_MODE;
    delete process.env.CONSENT_CHECK_RATE_LIMIT_PER_SEC;
    delete process.env.INITIATOR_CANNOT_APPROVE;
  }
});

test('an invalid env value is ignored in favor of the default', () => {
  process.env.CONSENT_CHECK_MODE = 'bogus';
  try {
    assert.equal(resolvedDefault(get('consentCheckMode')), 'blocklist'); // not a valid option → default
  } finally {
    delete process.env.CONSENT_CHECK_MODE;
  }
});

// --- validation --------------------------------------------------------------

test('select rejects values outside its options', () => {
  assert.equal(validateSetting(get('consentCheckMode'), 'allowlist'), 'allowlist');
  assert.throws(() => validateSetting(get('consentCheckMode'), 'nope'), /must be one of/);
});

test('number enforces min and rejects non-numbers', () => {
  assert.equal(validateSetting(get('reviewTtlDays'), 7), 7);
  assert.throws(() => validateSetting(get('reviewTtlDays'), 0), /at least 1/);
  assert.throws(() => validateSetting(get('reviewTtlDays'), 'x'), /must be a number/);
  assert.equal(validateSetting(get('reconcileIntervalMinutes'), 0), 0); // min 0 allows disable
});

test('boolean requires a real boolean', () => {
  assert.equal(validateSetting(get('ttlResetOnCoalesce'), false), false);
  assert.throws(() => validateSetting(get('ttlResetOnCoalesce'), 'true'), /true or false/);
});

test('phone region must be a 2-letter code and is upper-cased', () => {
  assert.equal(validateSetting(get('defaultPhoneRegion'), 'gb'), 'GB');
  assert.throws(() => validateSetting(get('defaultPhoneRegion'), 'USA'), /2-letter/);
});
