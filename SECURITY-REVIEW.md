# Security Review

Manual review of the auth, session/CSRF, credential-store, webhook, consent-check,
and web-console surfaces (PRODUCTION-READINESS §1). Reflects the code as reviewed
on 2026-08-26. Severity: Critical / High / Medium / Low / Info.

**Bottom line:** no Critical or High findings. The fundamentals are sound —
parameterized SQL, scrypt password hashing, timing-safe comparisons, RBAC on all
mutating routes, encrypted credentials with fail-fast key handling, CSRF tokens,
and verified webhook signatures. Findings are Medium/Low hardening items; the
quick ones are fixed in the same change that adds this file.

## ✅ Verified strong (no action)
- **SQL injection** — all queries are parameterized. The only two string
  interpolations (`services/systems.ts`) insert **hardcoded** table-name
  constants (`CONSENT_HISTORY_TABLES`, `CONFIG_CHILD_TABLES`), never user input.
- **Passwords** — scrypt (OWASP N=2^17, r=8, p=1), self-describing hash format,
  `timingSafeEqual` verify. Login is timing-uniform for unknown users and locks
  after 5 failures / 15 min.
- **Sessions** — random 32-byte tokens, server-side in PostgreSQL, sliding
  expiry, `HttpOnly; SameSite=Lax; Secure` (prod) cookie; sessions revoked on
  role change / disable.
- **CSRF** — per-session synchronizer token required (`X-CSRF-Token`,
  constant-time compare) on cookie-session mutating requests; machine/API-key and
  signature-verified webhook requests carry no session and are exempt by design.
- **Credential store** — AES-256-GCM, key derived from `APP_SECRET` (file-based,
  fail-fast in production, rotation via `npm run reencrypt`); secrets are never
  returned through the API.
- **Webhook signatures** — Twilio (HMAC-SHA1), SendGrid (ECDSA P-256), Telesign
  (HMAC-SHA256) all verified with constant-time / crypto verification.
- **Consent-check API** — keys sha256-hashed at rest, system-scoped, revocable,
  rate-limited; fail-closed contract; identities sent by POST body (never URLs).
- **RBAC** — every mutating `/api` route is role-gated or machine-authed; a user
  can't change their own role or disable themselves.
- **OIDC SSO** — PKCE (S256) + server-stored `state` with a 10-minute expiry.
- **Web console** — output is escaped (`esc()` for `innerHTML`; `textContent` /
  attributes elsewhere). No XSS sink found.
- **Body limits** — 2 MB JSON cap; consent-check batch capped at 1..1000.

## Findings

### Medium
1. **Missing HTTP security headers.** No CSP, `X-Frame-Options`,
   `X-Content-Type-Options`, `Referrer-Policy`, or HSTS. → **Fixed:** a headers
   middleware now sets them (`frame-ancestors 'none'` for clickjacking, `nosniff`,
   `no-referrer`, HSTS in production, a CSP). → **Tightened:** console
   JS is now an external file (`web/app.js`) with all event handlers bound via
   delegation, so `script-src` is `'self'` with no `'unsafe-inline'`. `style-src`
   keeps `'unsafe-inline'` for the page's `style=""` attributes.
2. **Internal error messages leaked to clients.** The global error handler and the
   webhook routes returned `err.message` on 500, which can disclose DB/internal
   details. → **Fixed:** 500s now log server-side and return a generic message
   (validation 400s still return their user-facing message).
3. **Webhook replay protection.** → **Fixed.** Two layers: inbound webhooks are
   de-duplicated on the platform's event id (Twilio `MessageSid`, SendGrid
   `sg_event_id`, Telesign `reference_id`) so a replay or platform retry is never
   ingested twice (the id is inside the signed payload, so it can't be forged);
   and where the platform signs a timestamp (SendGrid, Telesign) a stale
   timestamp is rejected (`webhookMaxSkewSeconds` setting, default 300s). The
   dedup table is pruned on the scheduled prune. Twilio has no signed timestamp,
   so its replay defense is dedup within the retention window (residual: a replay
   older than the window — bounded, since opt-out is idempotent).

### Low
4. **`X-Powered-By` header.** Advertised the framework. → **Fixed** (`disable`).
5. **Reverse-proxy awareness.** `trust proxy` wasn't set, so behind a TLS
   terminator `req.ip` (audit log) is the proxy and `req.protocol` is `http`. →
   **Fixed:** honor `TRUST_PROXY`. Set it in production; `WEBHOOK_PUBLIC_BASE`
   already handles the signed-URL case.
6. **Login brute-force / lockout DoS.** Lockout is per-account, so a known
   username can be locked by an attacker; there's no per-IP login throttle. →
   **Fixed:** per-IP throttle (`src/auth/login-throttle.ts`,
   `LOGIN_THROTTLE_*`) blocks an address after repeated failures, on top of the
   per-account lockout. Only failures count and a success resets, so legitimate
   users are unaffected.
7. **Bootstrap credentials.** `npm run seed` prints static default passwords. →
   **Fixed:** under `NODE_ENV=production` the seed requires
   `*_BOOTSTRAP_PASSWORD` env vars, refuses built-in defaults, and doesn't echo
   the secret. Rotation/disable steps: `RUNBOOK-key-and-credential-rotation.md`.

### Info / recommended process
- Run `npm audit` (and a dependency scanner) in CI; keep deps patched.
- Add automated security checks to CI; consider a periodic external pen-test
  before go-live.
- ✅ Done: CSP tightened — console JS moved to an external file with
  handlers bound via delegation, so `script-src` no longer needs `'unsafe-inline'`.

## Fixed in this change
Items 1, 2, 4, 5 — security headers, error-message sanitization, `x-powered-by`
disabled, and `trust proxy` support.

## Fixed since (follow-ups)
Item 3 (webhook replay protection), items 6 & 7 (per-IP login throttle
and bootstrap-credential hygiene) and CSP tightening — `script-src`
dropped `'unsafe-inline'`. All security-review follow-ups are closed.
