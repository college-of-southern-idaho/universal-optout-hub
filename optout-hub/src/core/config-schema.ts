/**
 * Schema for the runtime-configurable settings (DESIGN.md §13). One descriptor
 * per tunable knob — the single source of truth that drives default resolution,
 * validation, the admin API, and the Settings UI. Secrets are deliberately NOT
 * here (they stay in the environment / mounted files).
 *
 * Precedence: DB value (app_config) wins; an env var only seeds the default when
 * the key has no DB value; otherwise the built-in default applies.
 */

export type SettingKind = 'select' | 'number' | 'boolean' | 'text';

export interface SettingDef {
  key: string;
  group: string;
  label: string;
  help?: string;
  kind: SettingKind;
  options?: readonly string[]; // select
  min?: number;                // number
  env?: string;                // env var that seeds the default
  default: unknown;
}

// Jobs whose timers are read at startup — changing them reloads the scheduler.
export const SCHEDULER_KEYS = new Set(['reconcileIntervalMinutes', 'pruneIntervalHours', 'pollIntervalMinutes', 'alertScanMinutes']);

export const SETTINGS: readonly SettingDef[] = [
  // ---- Safety --------------------------------------------------------------
  {
    key: 'enableOutboundWrites', group: 'Safety',
    label: 'Push opt-out/opt-in writes to sending services',
    help: 'ON (production): the hub writes opt-outs/opt-ins into each writable platform. ' +
      'OFF (TEST MODE): the hub still ingests and records opt-ins/opt-outs and cascades them ' +
      'internally, but NEVER pushes a write to any sending service — it logs what it would have ' +
      'written. Turn OFF while testing integrations; turn ON for production.',
    kind: 'boolean', env: 'ENABLE_OUTBOUND_WRITES', default: true,
  },

  // ---- Consent decision ----------------------------------------------------
  {
    key: 'consentCheckMode', group: 'Consent decision', label: 'Unknown-identity posture',
    help: 'blocklist: send unless a revocation is on file (unknown → allow). allowlist: send only with a positive local opt-in (unknown → suppress).',
    kind: 'select', options: ['blocklist', 'allowlist'] as const, env: 'CONSENT_CHECK_MODE', default: 'blocklist',
  },
  {
    key: 'consentCheckRateLimitPerSec', group: 'Consent decision', label: 'Consent-check rate limit (req/s, default per key)',
    help: 'Hub-wide default per-key rate for POST /api/v1/consent/check. 0 disables. Per-key overrides still apply.',
    kind: 'number', min: 0, env: 'CONSENT_CHECK_RATE_LIMIT_PER_SEC', default: 60,
  },
  // Opt-out propagation is governed by the message-category cascade matrix
  // (services/categories.ts, DESIGN.md §10), not a scalar knob — see the
  // Consent categories screen. It intentionally has no entry here.

  // ---- Opt-in reviews ------------------------------------------------------
  {
    key: 'reviewTrigger', group: 'Opt-in reviews', label: 'When to queue a propagation review',
    kind: 'select', options: ['explicit_optout_elsewhere', 'any_state_elsewhere', 'never'] as const,
    default: 'explicit_optout_elsewhere',
  },
  { key: 'reviewTtlDays', group: 'Opt-in reviews', label: 'Pending review TTL (days)', kind: 'number', min: 1, default: 10 },
  { key: 'ttlResetOnCoalesce', group: 'Opt-in reviews', label: 'Reset TTL when a same-channel event coalesces', kind: 'boolean', default: true },
  { key: 'preselectSameChannel', group: 'Opt-in reviews', label: 'Pre-check same-channel systems in the review', kind: 'boolean', default: true },
  {
    key: 'initiatorCannotApprove', group: 'Opt-in reviews', label: 'Separation of duties (initiator cannot approve)',
    kind: 'boolean', env: 'INITIATOR_CANNOT_APPROVE', default: false,
  },

  // ---- Retention & alerts --------------------------------------------------
  { key: 'syncLagAlertHours', group: 'Retention & alerts', label: 'Sync-lag alert threshold (hours)', kind: 'number', min: 1, env: 'SYNC_LAG_ALERT_HOURS', default: 24 },
  { key: 'consentCheckRetainSuppressDays', group: 'Retention & alerts', label: 'Retain suppress-decision audit (days)', help: 'Statutory evidence; ~4 years.', kind: 'number', min: 1, env: 'CONSENT_CHECK_RETAIN_SUPPRESS_DAYS', default: 1461 },
  { key: 'consentCheckRetainOtherDays', group: 'Retention & alerts', label: 'Retain allow/error audit (days)', kind: 'number', min: 1, env: 'CONSENT_CHECK_RETAIN_OTHER_DAYS', default: 90 },
  { key: 'auditLogRetainDays', group: 'Retention & alerts', label: 'Retain operational audit log (days)', help: 'Operational audit_log rows prune after this many days. Compliance-relevant actions (approval decisions/auto-cancels, config changes, API-key create/revoke) are exempt and kept indefinitely.', kind: 'number', min: 1, env: 'AUDIT_LOG_RETAIN_DAYS', default: 14 },

  // ---- Scheduled jobs (0 = disabled; changing these reloads the scheduler) --
  { key: 'reconcileIntervalMinutes', group: 'Scheduled jobs', label: 'Reconciliation interval (minutes)', kind: 'number', min: 0, env: 'RECONCILE_INTERVAL_MINUTES', default: 0 },
  { key: 'pruneIntervalHours', group: 'Scheduled jobs', label: 'Audit-prune interval (hours)', kind: 'number', min: 0, env: 'PRUNE_INTERVAL_HOURS', default: 0 },
  { key: 'pollIntervalMinutes', group: 'Scheduled jobs', label: 'Inbound-poll interval (minutes)', kind: 'number', min: 0, env: 'POLL_INTERVAL_MINUTES', default: 0 },
  { key: 'alertScanMinutes', group: 'Scheduled jobs', label: 'Sync-lag alert scan interval (minutes)', help: 'How often to check for opt-outs that have not converged within the sync-lag threshold and raise an alert. 0 disables.', kind: 'number', min: 0, env: 'ALERT_SCAN_INTERVAL_MINUTES', default: 0 },

  // ---- Normalization -------------------------------------------------------
  { key: 'defaultPhoneRegion', group: 'Normalization', label: 'Default phone region (ISO-3166 alpha-2)', help: 'Region for parsing numbers written without a country code, e.g. US, CA, GB.', kind: 'text', env: 'DEFAULT_PHONE_REGION', default: 'US' },

  // ---- Webhooks ------------------------------------------------------------
  { key: 'webhookMaxSkewSeconds', group: 'Webhooks', label: 'Max webhook timestamp age (seconds; 0 disables)', help: 'Reject inbound webhooks whose signed timestamp is older/newer than this — a replay defense. Applies to platforms that sign a timestamp (SendGrid, Telesign).', kind: 'number', min: 0, env: 'WEBHOOK_MAX_SKEW_SECONDS', default: 300 },
] as const;

export const SETTING_BY_KEY: ReadonlyMap<string, SettingDef> = new Map(SETTINGS.map((s) => [s.key, s]));

/** Parse an env string into the setting's typed value, or undefined if unusable. */
function fromEnv(s: SettingDef): unknown {
  if (!s.env) return undefined;
  const raw = process.env[s.env];
  if (raw === undefined || raw === '') return undefined;
  switch (s.kind) {
    case 'boolean': return raw === '1' || raw.toLowerCase() === 'true';
    case 'number': { const n = Number(raw); return Number.isFinite(n) ? n : undefined; }
    case 'select': return s.options?.includes(raw) ? raw : undefined;
    case 'text': return raw;
  }
}

/** The seeded default: env value if usable, else the built-in default. */
export function resolvedDefault(s: SettingDef): unknown {
  const e = fromEnv(s);
  return e !== undefined ? e : s.default;
}

/** Validate + coerce an incoming value for a setting. Throws on invalid input. */
export function validateSetting(s: SettingDef, value: unknown): unknown {
  switch (s.kind) {
    case 'boolean':
      if (typeof value !== 'boolean') throw new Error(`${s.key} must be true or false`);
      return value;
    case 'number': {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(`${s.key} must be a number`);
      if (s.min !== undefined && n < s.min) throw new Error(`${s.key} must be at least ${s.min}`);
      return n;
    }
    case 'select':
      if (!s.options?.includes(String(value))) throw new Error(`${s.key} must be one of: ${s.options?.join(', ')}`);
      return String(value);
    case 'text': {
      const v = String(value).trim();
      if (s.key === 'defaultPhoneRegion' && !/^[A-Za-z]{2}$/.test(v)) throw new Error('region must be a 2-letter ISO code');
      return s.key === 'defaultPhoneRegion' ? v.toUpperCase() : v;
    }
  }
}
