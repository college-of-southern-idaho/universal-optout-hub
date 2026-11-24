/**
 * Production-readiness checks (surfaced in the operator System view — kept out of
 * the global chrome so the UI stays clean). Split into:
 *   - AUTOMATED checks the app can self-inspect (env, config) → pass/warn.
 *   - MANUAL items the app CANNOT verify at runtime (process supervision, backups,
 *     TLS certificate) → listed as 'manual' for a human to confirm; they never
 *     flip the overall status, so we don't imply a green we can't actually prove.
 *
 * `computeReadiness` is pure (takes already-resolved inputs) so it unit-tests
 * without env/DB — the caller resolves env/policy/secrets and passes them in.
 */

export type ReadinessStatus = 'pass' | 'warn' | 'manual';

export interface ReadinessCheck {
  key: string;
  label: string;
  status: ReadinessStatus;
  detail: string;
}

export interface ReadinessReport {
  overall: 'ready' | 'attention';
  warnCount: number;
  checks: ReadinessCheck[];
}

export interface ReadinessInputs {
  nodeEnvProduction: boolean;
  enableOutboundWrites: boolean;
  /** APP_SECRET is set, is not the dev default, and is at least 16 chars. */
  appSecretStrong: boolean;
  trustProxySet: boolean;
  /** Effective HTTPS enforcement (FORCE_HTTPS, defaulting on in production). */
  forceHttps: boolean;
  webhookPublicBaseSet: boolean;
  reconcileIntervalMinutes: number;
  alertScanMinutes: number;
}

export function computeReadiness(i: ReadinessInputs): ReadinessReport {
  const pass = (key: string, label: string, detail: string): ReadinessCheck => ({ key, label, status: 'pass', detail });
  const warn = (key: string, label: string, detail: string): ReadinessCheck => ({ key, label, status: 'warn', detail });
  const manual = (key: string, label: string, detail: string): ReadinessCheck => ({ key, label, status: 'manual', detail });

  const checks: ReadinessCheck[] = [
    i.nodeEnvProduction
      ? pass('node_env', 'Production environment', 'NODE_ENV=production.')
      : warn('node_env', 'Production environment', "NODE_ENV is not 'production' — the app runs with dev conveniences and a weaker security posture."),

    i.enableOutboundWrites
      ? pass('outbound_writes', 'Outbound writes enabled', 'The hub pushes opt-outs/opt-ins to sending services.')
      : warn('outbound_writes', 'Outbound writes enabled', 'Test mode — outbound writes are OFF; the hub receives but pushes nothing to platforms.'),

    i.appSecretStrong
      ? pass('app_secret', 'Strong APP_SECRET', 'Set, non-default, and ≥16 chars — the credential store is properly keyed.')
      : warn('app_secret', 'Strong APP_SECRET', 'APP_SECRET is missing, the dev default, or too short — stored platform credentials are not safely encrypted.'),

    i.trustProxySet
      ? pass('trust_proxy', 'Reverse-proxy trust', 'TRUST_PROXY is set — real client IPs, HTTPS detection, and the per-IP login throttle work.')
      : warn('trust_proxy', 'Reverse-proxy trust', 'TRUST_PROXY is unset — behind a proxy, req.ip is the proxy and the per-IP login throttle is ineffective (see DEPLOYMENT.md).'),

    i.forceHttps
      ? pass('https', 'HTTPS enforcement', 'Plaintext requests are redirected to HTTPS and HSTS is sent.')
      : warn('https', 'HTTPS enforcement', 'HTTPS enforcement is off (FORCE_HTTPS) — set it (and TRUST_PROXY) behind a TLS terminator.'),

    i.webhookPublicBaseSet
      ? pass('webhook_base', 'Public webhook base', 'WEBHOOK_PUBLIC_BASE is set for inbound webhook URLs / provisioning.')
      : warn('webhook_base', 'Public webhook base', 'WEBHOOK_PUBLIC_BASE is unset — inbound webhook provisioning and signed-URL matching will not work.'),

    i.reconcileIntervalMinutes > 0
      ? pass('reconcile', 'Reconciliation scheduled', `Runs every ${i.reconcileIntervalMinutes} min — drift self-heals.`)
      : warn('reconcile', 'Reconciliation scheduled', 'The reconciler is not scheduled (interval 0) — platform drift will not self-heal automatically.'),

    i.alertScanMinutes > 0
      ? pass('alerting', 'Sync-lag alerting scheduled', `Scans every ${i.alertScanMinutes} min for opt-outs past the convergence threshold.`)
      : warn('alerting', 'Sync-lag alerting scheduled', 'The sync-lag alert scan is not scheduled (interval 0) — un-converged opt-outs will not raise an alert.'),

    // Manual — the app cannot verify these at runtime; a human confirms them.
    manual('supervision', 'Process supervision', 'Confirm the app runs under an auto-restart supervisor — it fails fast on faults (DEPLOYMENT.md → Process supervision).'),
    manual('backups', 'Backups & DR', 'Confirm scheduled PostgreSQL backups + a tested restore, with APP_SECRET escrowed (RUNBOOK-backup-and-dr.md).'),
    manual('tls_cert', 'TLS certificate', 'Confirm the reverse proxy serves a valid, current TLS certificate.'),
  ];

  const warnCount = checks.filter((c) => c.status === 'warn').length;
  return { overall: warnCount === 0 ? 'ready' : 'attention', warnCount, checks };
}
