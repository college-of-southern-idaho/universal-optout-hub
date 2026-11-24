# Runbook — Key & credential rotation

Operational procedures for rotating the encryption key and the accounts/credentials
the hub relies on. Covers credential hygiene. For broader operational
runbooks see the other operational runbooks.

Secrets are supplied via the environment or `<NAME>_FILE` mounts (see
`optout-hub/.env.example`); they are never stored in the database's config table.

---

## 1. Rotate `APP_SECRET` (the encryption key)

Stored service credentials (`system_credentials.secret_enc`) are encrypted under a
key derived from `APP_SECRET`. Rotating the secret therefore requires re-encrypting
every stored credential under the new key. The `reencrypt` tool does this in one
transaction and is safe to re-run (rows already under the new key are skipped).

**When:** on a schedule (e.g. annually), on suspected exposure, or on staff offboarding.

**Steps**
1. Generate a new secret (≥ 16 chars), e.g. `openssl rand -base64 48`.
2. Provide the current secret as `APP_SECRET_OLD` and the new one as `APP_SECRET`
   (either may come from a `*_FILE` mount):
   ```
   APP_SECRET_OLD=<current>  APP_SECRET=<new>  npm run reencrypt
   ```
   Output: `re-encrypted N credential(s); M already under the new key.`
3. Roll out the new `APP_SECRET` to every running instance (deploy / restart) so the
   app decrypts with the new key.
4. **Retire `APP_SECRET_OLD`** — remove it from the environment / secret store.

**Rollback:** if step 3 fails, redeploy with the old `APP_SECRET`; the re-encrypt is
idempotent, so re-running after fixing the issue is safe. Keep `APP_SECRET_OLD`
available until the rollout is confirmed healthy.

---

## 2. Rotate bootstrap / seed account passwords

The seed (`npm run seed`) creates the initial accounts (`admin`, `op.demo`,
`app.demo`) only when the `users` table is empty.

- **Production (`NODE_ENV=production`)**: the seed **requires** `ADMIN_BOOTSTRAP_PASSWORD`,
  `OPERATOR_BOOTSTRAP_PASSWORD`, and `APPROVER_BOOTSTRAP_PASSWORD` — it refuses to
  create an account with a built-in default and never echoes the password to the log.
  Set strong, unique values before first seed.
- **Non-production**: falls back to `ChangeMe-*` dev defaults for convenience.

**Rotate an existing account's password** (no re-seed needed):
- In the console: **Admin → Users → Reset password** (admin role), or
- API: `POST /api/users/:id/password` with `{ "password": "<new>" }` (admin session).

Minimum length is enforced at 10 characters (`hashPassword`).

**Disable rather than rotate** (e.g. retire the demo accounts in production):
- **Admin → Users** → set the account **status** to disabled, or
- API: the user-status route (admin). A disabled account cannot sign in.

---

## 3. Brute-force protections (operator reference)

Two independent layers guard sign-in:

- **Per-account lockout** (database, shared across instances): after 5 consecutive
  failures an account is locked for a cooldown window. A successful login clears it.
- **Per-IP throttle** (`src/auth/login-throttle.ts`, in-memory per instance): after
  `LOGIN_THROTTLE_MAX_FAILURES` failed attempts from one address within
  `LOGIN_THROTTLE_WINDOW_MINUTES`, that IP is blocked for
  `LOGIN_THROTTLE_BLOCK_MINUTES` (defaults 10 / 15 / 15; `0` disables). Only failed
  attempts count and a success resets the counter, so legitimate users are unaffected.
  A throttled attempt returns `429` with `Retry-After`; watch for the
  `login_throttled` log event.

**If a legitimate user is locked out:** wait out the window, or (per-account) an admin
can reset the account via **Admin → Users**. Behind a proxy, ensure `TRUST_PROXY` is
set so throttling keys on the real client IP, not the proxy.
