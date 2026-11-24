# Containerized deployment (Docker + nginx)

A self-contained deployment of the Universal Opt-Out Hub: **nginx terminates TLS**
and reverse-proxies to the **app**, which talks to a **PostgreSQL** container. One
command brings up the whole stack with migrations applied.

```
            :443 / :80
   client ───────────► nginx ──► app (:3000) ──► PostgreSQL
                       (TLS)     (Node/tsx)       (:5432, internal)
```

Only nginx publishes ports. The app and database live on the internal compose
network. **The app enforces its own security** (HTTPS redirect + HSTS, CSP and
security headers, CSRF, fail-closed consent decisions, encrypted-at-rest
credentials), so this stack is hardened end to end — and you can swap nginx for
any other proxy (see *Using a different proxy*).

## Prerequisites
- Docker + Docker Compose v2 (`docker compose`).
- A TLS certificate for your hostname (or generate a self-signed one for testing).

## Quick start

```bash
cd optout-hub/deploy

# 1. Configure secrets
cp .env.example .env
#   edit .env → set APP_SECRET (openssl rand -hex 32) and POSTGRES_PASSWORD

# 2. Provide a TLS cert as certs/server.crt + certs/server.key
./gen-selfsigned-cert.sh your-host.example.edu     # testing only; or drop real certs in ./certs

# 3. Build + run
docker compose up -d --build
```

Then open **https://your-host.example.edu/** (or https://localhost/ with the
self-signed cert — your browser will warn, which is expected for self-signed).

On first start the app logs the generated bootstrap admin credentials — grab them
from `docker compose logs app` and change the password immediately.

## TLS certificates

nginx reads `certs/server.crt` (full chain) and `certs/server.key`.

- **Testing:** `./gen-selfsigned-cert.sh <hostname>` writes a self-signed pair.
- **Production:** use a real certificate.
  - *Let's Encrypt:* issue the cert on the host (e.g. with certbot; the nginx
    config already serves `/.well-known/acme-challenge/` from the `certbot-www`
    volume over HTTP), then place/renew the files at `certs/server.crt` and
    `certs/server.key` and `docker compose restart nginx`.
  - *Your own CA / wildcard:* just drop the full-chain cert and key in `certs/`.

Certs and `.env` are git-ignored — never commit them.

## What's enforced (security posture)

| Control | Where |
|---|---|
| TLS termination + HTTP→HTTPS (308) redirect | nginx (and the app, via `FORCE_HTTPS`) |
| HSTS, CSP (`script-src 'self'`), `nosniff`, `X-Frame-Options: DENY`, referrer policy | app |
| Real client IP for logs + login throttle (`req.ip`/`req.secure`) | app `TRUST_PROXY=1` + nginx `X-Forwarded-*` |
| `/metrics` not reachable from outside | nginx (`deny`) + app `METRICS_TOKEN` |
| Dotfile / secret-probe (`/.env`, `/.git`) blocked | nginx |
| Credentials encrypted at rest (AES-256-GCM) | app (`APP_SECRET`) |
| Fails closed if the DB is unreachable | app |
| Runs as non-root, under tini, with a healthcheck | app image |
| Weak/missing `APP_SECRET` refused in production | app |

## Production notes

- **Use a managed database** if you can: drop the `db` service and set
  `DATABASE_URL` to your managed PostgreSQL (append `?sslmode=require`). The bundled
  `db` is fine for small/self-hosted deployments — just keep its port unpublished
  (it already is) and back up the `pgdata` volume.
- **Secrets:** `.env` is convenient, but the app also supports file-based secrets
  (`APP_SECRET_FILE`, `DATABASE_URL_FILE`, `OIDC_CLIENT_SECRET_FILE`, …). Mount them
  as Docker/Swarm/Kubernetes secrets and set the `*_FILE` vars instead of inline.
- **Backups & key:** follow [`RUNBOOK-backup-and-dr.md`](../../RUNBOOK-backup-and-dr.md).
  A database backup is useless without the matching `APP_SECRET` — capture it
  separately.
- **Key rotation:** set `APP_SECRET_OLD` to the old key, then
  `docker compose exec app npm run reencrypt`, then retire `APP_SECRET_OLD`
  (see [`RUNBOOK-key-and-credential-rotation.md`](../../RUNBOOK-key-and-credential-rotation.md)).

## Using a different proxy

Because the app secures itself, nginx is just the default. To use Caddy, Traefik,
a cloud load balancer, etc.: terminate TLS there, proxy to the app on port 3000,
and forward `X-Forwarded-Proto` and `X-Forwarded-For` (keep `TRUST_PROXY=1` on the
app). Remove the `nginx` service and `expose`/publish the app yourself, or point
your external proxy at it. See the Caddy example in
[`DEPLOYMENT.md`](../../DEPLOYMENT.md).

## Operations

```bash
docker compose logs -f app            # follow app logs (structured JSON)
docker compose exec app npm run migrate   # re-apply migrations (idempotent)
docker compose pull && docker compose up -d --build   # update to a new version
docker compose down                   # stop (keeps the pgdata volume)
```

Health: nginx proxies `/healthz` (liveness) and `/readyz` (DB reachable); the app
container also has a Docker `HEALTHCHECK` on `/healthz`.
