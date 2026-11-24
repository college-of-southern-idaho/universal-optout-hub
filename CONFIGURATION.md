# Configuration Reference — Consent Hub

Every setting the hub reads, in one place. This is a **reference** — for the ordered
setup path see the **[Setup Guide](SETUP-GUIDE.md)**; for host/proxy specifics see
**[Deployment](DEPLOYMENT.md)**.

## Two kinds of configuration

1. **Process environment variables** — read at startup; set them in the environment
   (or a `.env` file in `optout-hub/`, or your process supervisor / secret store).
   Runtime and infrastructure concerns live here.
2. **Database-stored operational policy** — the consent posture, cascade matrix,
   retention windows, scheduler intervals, and similar knobs live in the database and
   are edited in the console **Settings** screen. Changes take effect immediately and
   are audited. The matching environment variable only **seeds the initial default**
   on first boot; after that the database is authoritative. These are listed last.

---

## Secrets and the `<NAME>_FILE` convention

Every secret resolves from **either** an environment variable **or** a mounted file
named `<NAME>_FILE` (the file's trimmed contents) — so you can point at Docker/K8s
secrets, Azure Key Vault CSI, or Vault without putting secrets in the environment. In
`NODE_ENV=production` the app **refuses to boot** if a required secret is missing.

| Secret | Required | Purpose |
|---|---|---|
| `APP_SECRET` (or `APP_SECRET_FILE`) | **Yes (prod)** | Encrypts the credential store and signs sessions. Boot **fails** on a missing/weak/dev-default value in production. **Keep it recoverable** — without it the stored platform credentials cannot be decrypted. |
| `APP_SECRET_OLD` (or `APP_SECRET_OLD_FILE`) | On rotation | The previous `APP_SECRET`, used by `npm run reencrypt` to re-encrypt the credential store during rotation. See [RUNBOOK-key-and-credential-rotation.md](RUNBOOK-key-and-credential-rotation.md). |
| `DATABASE_URL` (or `DATABASE_URL_FILE`) | **Yes** | PostgreSQL connection string. |
| `OIDC_CLIENT_SECRET` (or `OIDC_CLIENT_SECRET_FILE`) | If using SSO | OAuth client secret for the OIDC provider. |

---

## Core runtime (environment)

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | Set to `production` to enable production safety: fail-fast on a weak `APP_SECRET`, HTTPS/HSTS defaults on, bootstrap passwords required. |
| `PORT` | `3000` | HTTP port the app listens on (behind your TLS-terminating proxy). |
| `TRUST_PROXY` | *(unset)* | Set (e.g. `1`) when behind a reverse proxy/load balancer so the app sees the real client IP and HTTPS scheme. Required for the HTTPS redirect, HSTS, and the per-IP login throttle to work correctly. See [Deployment](DEPLOYMENT.md). |
| `FORCE_HTTPS` | on in production | `1/true/yes/on` to force (or `0/false` to disable) the plaintext→HTTPS redirect + HSTS. `/healthz` and `/readyz` are exempt so load balancers can probe over HTTP. |
| `WEBHOOK_PUBLIC_BASE` | *(unset)* | The hub's public base URL, used to build inbound webhook URLs and to match the URL signatures are verified against. Set it behind a proxy. |
| `PG_POOL_MAX` | `10` | Max PostgreSQL connections in the pool. Raise for high consent-check throughput (see [PERFORMANCE.md](optout-hub/PERFORMANCE.md)). |
| `REDIS_URL` | *(unset)* | If set, the per-key/per-IP rate limits use a shared Redis store (atomic token bucket) so limits hold across instances. Unset = in-memory (single instance). |
| `METRICS_TOKEN` | *(unset)* | If set, `GET /metrics` requires it as a bearer token. **Unset leaves `/metrics` open** — set it, or block `/metrics` at the edge. |
| `TWILIO_EVENTS_TOKEN` | *(unset)* | Shared token that authenticates the Twilio **Event Streams** sink (`POST /api/webhooks/twilio-events/<system>?token=…`). |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. |
| `LOG_FORMAT` | `json` | `pretty` for human-readable logs; otherwise structured JSON lines. |
| `HUB_NO_LISTEN` | *(unset)* | `1` imports the app without starting the HTTP listener (used by the test harness). Leave unset in normal operation. |

---

## Authentication & SSO (environment)

| Variable | Default | Purpose |
|---|---|---|
| `OIDC_ISSUER` | *(unset)* | OIDC provider issuer URL. Setting the `OIDC_*` group enables SSO. |
| `OIDC_CLIENT_ID` | *(unset)* | OAuth client ID. |
| `OIDC_CLIENT_SECRET` | *(unset)* | OAuth client secret (see Secrets above; supports `_FILE`). |
| `OIDC_REDIRECT_URI` | *(unset)* | The callback URL registered with the provider. |
| `OIDC_PROVIDER_NAME` | *(unset)* | Display name for the SSO button. |
| `OIDC_ROLE_CLAIM` | *(unset)* | Token claim to read roles from. |
| `OIDC_ROLE_MAP` | *(unset)* | Maps provider roles → hub roles (viewer/operator/approver/admin). |
| `SSO_JIT_ROLE` | *(unset)* | Default role for a just-in-time provisioned SSO user. |
| `AUTH_DEV_MOCK_SSO` | *(unset)* | **Dev only** — mock the SSO flow without a real provider. Never set in production. |
| `<ACCOUNT>_BOOTSTRAP_PASSWORD` | *(unset)* | Seeds the initial admin/demo account passwords. **Required in production** (the seed refuses built-in defaults). Rotate/disable per the [rotation runbook](RUNBOOK-key-and-credential-rotation.md). |

### Login throttle

| Variable | Default | Purpose |
|---|---|---|
| `LOGIN_THROTTLE_MAX_FAILURES` | `10` | Failed sign-ins from one IP before a temporary block. |
| `LOGIN_THROTTLE_WINDOW_MINUTES` | `15` | Window over which failures are counted. |
| `LOGIN_THROTTLE_BLOCK_MINUTES` | `15` | How long the IP is blocked after tripping. |

*(Only failures count; a success resets the counter, so legitimate users are unaffected. Requires `TRUST_PROXY` to see the real client IP.)*

---

## Operational policy (database-stored; edited in **Settings**)

These live in the database and are edited in the console; the environment variable
only **seeds the initial value** on first boot. After that, change them in **Settings**
(changes are immediate and audited).

| Setting (env seed) | Default | Purpose |
|---|---|---|
| `ENABLE_OUTBOUND_WRITES` | `true` | Master kill switch for hub-originated platform writes. Set `false` to record consent internally without pushing to live platforms (validation / test mode). |
| `CONSENT_CHECK_MODE` | `blocklist` | `blocklist` (unknown → allow) or `allowlist` (unknown → suppress) posture for the consent-check API. |
| `CONSENT_CHECK_RATE_LIMIT_PER_SEC` | `60` | Default per-service-key rate limit for the consent-check API (`429` + `Retry-After` on breach; overridable per key). |
| `INITIATOR_CANNOT_APPROVE` | `false` | Separation of duties: when `true`, the person who initiated an opt-in review cannot approve it. |
| `SYNC_LAG_ALERT_HOURS` | `24` | Operational sync-lag threshold above which an opt-out propagation is flagged (the 10-business-day regulatory ceiling is a hard `breach`). |
| `CONSENT_CHECK_RETAIN_SUPPRESS_DAYS` | `1461` (~4 yr) | Retention for `suppress` consent-check audit rows — the § 227(c)(5) evidence. |
| `CONSENT_CHECK_RETAIN_OTHER_DAYS` | `90` | Retention for `allow`/`error` consent-check audit rows. |
| `AUDIT_LOG_RETAIN_DAYS` | `14` | Retention for operational `audit_log` rows. Compliance-relevant actions (approval decisions/auto-cancels, config changes, API-key create/revoke) are exempt and kept indefinitely. |
| `RECONCILE_INTERVAL_MINUTES` | `0` (off) | Scheduled reconciliation interval; `0` disables the timer (still runnable on demand). |
| `PRUNE_INTERVAL_HOURS` | `0` (off) | Scheduled prune interval (consent-check **and** operational audit_log prune); `0` disables. |
| `POLL_INTERVAL_MINUTES` | `0` (off) | Scheduled inbound-poll interval for poll-delivery platforms; `0` disables. |
| `ALERT_SCAN_INTERVAL_MINUTES` | `0` (off) | How often to scan for non-converged opt-outs and raise sync-lag alerts; `0` disables. |
| `DEFAULT_PHONE_REGION` | `US` | ISO-3166 alpha-2 region for parsing phone numbers written without a country code. |
| `WEBHOOK_MAX_SKEW_SECONDS` | `300` | Reject inbound webhooks whose signed timestamp is older/newer than this (replay defense; `0` disables). Applies to platforms that sign a timestamp (SendGrid, Telesign). |

Additional policy not surfaced as a single env seed — notably the **message-category
opt-out cascade matrix** and per-category review triggers/TTLs — is edited entirely in
**Settings**. `ALERT_WEBHOOK_URL` (Slack/Teams-compatible) can be set so breach-level
sync-lag alerts post to a channel.

---

## Precedence & tips

- **Secrets:** `<NAME>_FILE` takes precedence over the plain `<NAME>` variable.
- **Policy knobs:** the environment variable is read **only to seed** the initial
  database value. Once seeded, edit in **Settings** — re-setting the env var does not
  override the stored value.
- **Scheduled jobs are off by default** (`*_INTERVAL_* = 0`). Enable them explicitly
  in production, and point monitoring at `/readyz`.
- Keep deployment-specific values (hostnames, real secrets, per-org tuning) in your
  secret store / environment, not in committed files.
