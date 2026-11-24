import test from 'node:test';
import assert from 'node:assert/strict';
import { computeReadiness, type ReadinessInputs } from '../src/core/readiness.js';

const READY: ReadinessInputs = {
  nodeEnvProduction: true,
  enableOutboundWrites: true,
  appSecretStrong: true,
  trustProxySet: true,
  forceHttps: true,
  webhookPublicBaseSet: true,
  reconcileIntervalMinutes: 60,
  alertScanMinutes: 30,
};

test('computeReadiness: all automated checks pass → overall ready, 0 warns', () => {
  const r = computeReadiness(READY);
  assert.equal(r.overall, 'ready');
  assert.equal(r.warnCount, 0);
  // Manual items are still listed (they never flip the overall status).
  const manual = r.checks.filter((c) => c.status === 'manual').map((c) => c.key);
  assert.deepEqual(manual.sort(), ['backups', 'supervision', 'tls_cert']);
});

test('computeReadiness: each missing config raises exactly one warn', () => {
  const cases: Array<[Partial<ReadinessInputs>, string]> = [
    [{ nodeEnvProduction: false }, 'node_env'],
    [{ enableOutboundWrites: false }, 'outbound_writes'],
    [{ appSecretStrong: false }, 'app_secret'],
    [{ trustProxySet: false }, 'trust_proxy'],
    [{ forceHttps: false }, 'https'],
    [{ webhookPublicBaseSet: false }, 'webhook_base'],
    [{ reconcileIntervalMinutes: 0 }, 'reconcile'],
    [{ alertScanMinutes: 0 }, 'alerting'],
  ];
  for (const [override, key] of cases) {
    const r = computeReadiness({ ...READY, ...override });
    assert.equal(r.overall, 'attention', `${key} should mark attention`);
    assert.equal(r.warnCount, 1, `${key} should raise exactly one warn`);
    const warned = r.checks.find((c) => c.status === 'warn');
    assert.equal(warned?.key, key);
  }
});

test('computeReadiness: manual items never count toward warnCount', () => {
  const r = computeReadiness(READY);
  assert.equal(r.warnCount, 0);
  assert.equal(r.checks.filter((c) => c.status === 'manual').length, 3);
});
