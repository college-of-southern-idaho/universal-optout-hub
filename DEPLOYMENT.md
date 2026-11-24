# Deployment

Operational setup for running the hub: choosing **test vs production mode**, the
**reverse proxy / TLS** wiring (including the easy-to-miss `TRUST_PROXY`), and
**process supervision**. The hub serves **plain HTTP** and is designed to run
**behind a TLS-terminating reverse proxy** (nginx, Caddy, a cloud load balancer,
IIS/ARR).

> Ties into the "TLS termination + reverse-proxy" work and
> PRODUCTION-READINESS.md §1.

---

## Starting the app

The app runs directly under the `tsx` runtime — **no build step**. What makes a
process "production" vs "development" is the **environment** (`NODE_ENV`,
`APP_SECRET`, `TRUST_PROXY`, `ENABLE_OUTBOUND_WRITES`, …), **not** the command.

| Command | Use |
|---|---|
| `npm start` | Production / default — runs `tsx src/api/server.ts` in the foreground. |
| `npm run dev` | Local development — `tsx watch …`, auto-reloads on file changes. |

In a real production deployment you don't run an npm script directly — a
**process supervisor** runs `node --import tsx src/api/server.ts` so the app is
restarted on a crash (it fails fast). See **Process supervision** below.

**Deploying an update** (your-hub.example.edu): `git pull` → `npm install` **only if
dependencies changed** → restart the app (`npm start` in the foreground, or
restart the supervised service, e.g. `nssm restart ConsentHub`).

---

## Test mode vs production

The hub runs in one of two modes, selected by a single switch —
**`ENABLE_OUTBOUND_WRITES`** (env, or **Settings → Safety**):

- **Production (`true`, the default):** the hub pushes opt-outs/opt-ins into each
  writable platform's suppression/subscription list.
- **Test mode (`false`):** the hub still **receives and records** opt-ins/opt-outs
  and cascades them internally, but **never pushes a write to any sending service**
  — it logs "would have written." Use this to stand up and validate integrations
  without ever touching a live vendor's suppression list.

### Configuring test mode

1. **Engage the switch:** set `ENABLE_OUTBOUND_WRITES=false` and **restart** (it's
   read at startup). On Windows/IIS the env-precedence rule applies — a value set
   in the Windows Service / `web.config` env **overrides `.env`**.
2. **Confirm it's engaged:** every startup logs a loud **`outbound_writes_disabled`**
   warning, and each suppressed write logs **`outbound_write_suppressed`** ("would
   have written…"). No startup warning ⇒ you are **not** in test mode.
3. **Wire the RECEIVE side** — test mode is about proving *inbound* works, so this
   is the config that must be in place (none of it is affected by the switch):
   - **`WEBHOOK_PUBLIC_BASE`** = the hub's public HTTPS base (inbound webhooks + provisioning).
   - Per-platform inbound: point each platform's webhook / MO callback at the hub,
     set up the Twilio **Event Streams** sink (**`TWILIO_EVENTS_TOKEN`**), or enable
     **polling** — see INTEGRATION.md §3. Register each service with **real
     credentials** so it can receive (inbound does not need the write-capability flags).
4. **Everything else stays production-grade.** Test mode is *not* a reason to skip
   hardening — an internet-facing box holding real vendor credentials still needs
   `TRUST_PROXY`, a production `APP_SECRET` (`NODE_ENV=production`), security
   headers, and process supervision (all below).

### What test mode does and does NOT change

- **Still runs (so you can fully validate):** inbound ingest (webhook / Event
  Streams / sender-report / poll), the internal opt-out **cascade + projection**,
  consent-check gate decisions, and all reports/audit.
- **Suppressed:** the three outbound write paths — the opt-out cascade write, the
  reconciler drift-correction, and the approval opt-in write. No `hub_write`, no
  platform API call, no unwritable-alert noise (just the `outbound_write_suppressed`
  log line).

### Going to production

1. Set `ENABLE_OUTBOUND_WRITES=true` (or Settings → Safety) and **restart** — the
   `outbound_writes_disabled` startup warning disappears.
2. **Run a reconcile** (`POST /api/reconcile`, or the scheduled reconciler) to
   **flush** the opt-outs accumulated during testing out to the platforms —
   reconciliation detects the hub-vs-platform divergence and writes the corrections.

---

## Set `TRUST_PROXY` (don't skip this)

When the app sits behind a proxy, Express only reports the **real client** IP and
scheme if it's told to trust the proxy's `X-Forwarded-*` headers:

```bash
TRUST_PROXY=1        # number of proxy hops in front of the app (1 = one proxy)
# or: TRUST_PROXY=loopback   # trust a proxy on the same host
```

**Why it matters — the symptom if you skip it:** every external request logs as
`"ip":"::ffff:127.0.0.1"` (the proxy's own connection), because `req.ip` sees the
proxy, not the client. Consequences:

- **The per-IP login throttle is neutered** — it keys on `req.ip`, so all clients
  collapse into a single `127.0.0.1` bucket. A brute-force source is
  indistinguishable from everyone else, and one attacker's failures can throttle
  *all* users at once.
- **Audit / session / access logs can't attribute or block a real source IP.**
- **HTTPS enforcement loops** — with `FORCE_HTTPS` on (the default in production),
  `req.secure` is only true when `TRUST_PROXY` is set; otherwise every request
  looks plaintext and the 308→https redirect loops. The app logs a
  `force_https_without_trust_proxy` warning to catch exactly this.

Related env vars:

| Var | Purpose |
|---|---|
| `TRUST_PROXY` | Trust the proxy's `X-Forwarded-For` / `X-Forwarded-Proto` (see above). |
| `FORCE_HTTPS` | `1`/`0` to force (or disable) the plaintext→HTTPS redirect + HSTS. Defaults **on** in production. `/healthz` and `/readyz` are exempt so load balancers can probe over plain HTTP. |
| `WEBHOOK_PUBLIC_BASE` | The public `https://…` base the app advertises for inbound webhooks — set it to the external URL the proxy serves, not the app's internal host:port. |

Also: **don't expose the app's own port to the internet.** Bind the proxy to
443/80 and firewall the app port (default `3000`) so traffic can only arrive
through the proxy. The scanner traffic in the logs reaches the app *via* the
proxy — the app port itself should not be directly reachable. This matters more
once `TRUST_PROXY` is set: the app now believes `X-Forwarded-For`, so a client
that can reach the app port directly could **spoof its IP**. With the port locked
down, only the proxy can set that header.

### Verifying `TRUST_PROXY`

`TRUST_PROXY` is read once at startup, so **restart the app after setting it** (a
plain env change on a running process has no effect). Then confirm:

- [ ] **Restarted** — the value is only picked up on boot (`git pull` + restart).
- [ ] **Startup log** — the `force_https_without_trust_proxy` warning is **gone**
      (it only logs when HTTPS enforcement is on *and* `TRUST_PROXY` is unset).
- [ ] **Access log shows real client IPs** — the `ip` field on an external request
      (your browser through the proxy, or the next `.env`-scanner hit) is the real
      client address, **not** `::ffff:127.0.0.1`. This is the definitive check.
- [ ] **App port is firewalled** — reachable only via the proxy (see above), so
      `X-Forwarded-For` can't be spoofed.

If the `ip` still shows `127.0.0.1` after a restart, the proxy isn't forwarding
`X-Forwarded-For` — check the `proxy_set_header X-Forwarded-For` /
`X-Forwarded-Proto` lines in the sample config below. If plaintext requests start
looping to `https://`, `TRUST_PROXY` is set but the proxy isn't sending
`X-Forwarded-Proto` (or the hop count is wrong — use the number of proxies in
front of the app).

Once verified, two things are correct that weren't before: `req.secure` (so the
HTTPS redirect + HSTS behave) and `req.ip` (so the **per-IP login throttle**
buckets by real client instead of lumping everyone into `127.0.0.1`).

---

## Sample nginx config

TLS termination + forward the real client info + block dotfile/secret probes
(`/.env`, `/.git`, …) so they're refused at the edge and never hit the app or
clutter its logs. The `.well-known` carve-out keeps ACME/Let's Encrypt renewals
working.

```nginx
server {
    listen 443 ssl;
    server_name your-hub.example.edu;

    ssl_certificate     /etc/ssl/certs/your-host.crt;
    ssl_certificate_key /etc/ssl/private/your-host.key;

    # Refuse dotfile / secret-scanner probes at the edge (except ACME challenges).
    # The app already 404s these, but blocking here stops the log noise and keeps
    # obvious scanners away from the rate limiter.
    location ~ /\.(?!well-known) {
        deny all;
        return 404;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;      # the hub, bound to localhost
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;   # lets the app see it's HTTPS
        proxy_http_version 1.1;
    }
}

# Redirect plain HTTP to HTTPS (the app also does this once TRUST_PROXY is set,
# but terminating it here is cleaner). Keep ACME reachable over HTTP.
server {
    listen 80;
    server_name your-hub.example.edu;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 308 https://$host$request_uri; }
}
```

With `TRUST_PROXY=1` set on the app, `X-Forwarded-For` from this config makes
`req.ip` the real client, `req.secure` true, and the login throttle + access logs
correct.

### Caddy equivalent

Caddy terminates TLS automatically and forwards the right headers out of the box;
you only need to add the dotfile block:

```caddyfile
your-hub.example.edu {
    @dotfiles path_regexp /\.(?!well-known)
    respond @dotfiles 404
    reverse_proxy 127.0.0.1:3000
}
```

---

## Edge hardening (from the security assessment)

A non-destructive external assessment found the app's **own** controls strong (auth
closed, no sensitive-file exposure, tight CSP/HSTS, TLS 1.3, TRACE off, CORS closed)
but flagged four **edge/hosting** items. All are proxy/ops config, not app changes.
Items 1–3 were remediated and verified on your-hub.example.edu on 2026-09-16;
the rules below are the ones that were confirmed working.

> **IIS rule ordering (the gotcha that bites first).** In the site's URL Rewrite
> list the inbound rules below must sit **above** the ARR reverse-proxy rule and use
> `stopProcessing="true"`. The ARR proxy rule typically matches `.*`, so if it's
> above these it proxies the request to the app before they ever run — the redirect
> and `/metrics` block silently do nothing. Target order:
> **HTTP→HTTPS redirect → Block `/metrics` → ARR proxy.** Outbound rules (item 3)
> live in a separate `<outboundRules>` block and don't interact with ordering.
>
> **Testing patterns in IIS Manager.** The *Test Pattern* box expects the URL path
> with the **leading slash already stripped** and no scheme/host — enter `metrics`,
> not `/metrics` or `https://host/metrics`, or it will report "does not match" even
> though the rule is correct at runtime.

1. **Redirect HTTP → HTTPS at the edge.** Behind a TLS terminator the app often
   always sees `X-Forwarded-Proto: https`, so its built-in `FORCE_HTTPS` redirect
   never fires and plain-HTTP requests are served in cleartext. Enforce it at the proxy:
   - **IIS / ARR** — a URL Rewrite inbound rule (place above the ARR proxy rule):
     ```xml
     <rule name="HTTP to HTTPS redirect" stopProcessing="true">
       <match url="(.*)" />
       <conditions><add input="{HTTPS}" pattern="off" /></conditions>
       <action type="Redirect" url="https://{HTTP_HOST}/{R:1}" redirectType="Permanent" />
     </rule>
     ```
     Use `{HTTPS}` when **IIS terminates TLS** (cert bound to the :443 binding). If
     TLS is terminated **upstream** (IIS only ever sees HTTP), `{HTTPS}` is always
     `off` and this rule loops — key off the forwarded header instead:
     `<add input="{HTTP_X_FORWARDED_PROTO}" pattern="^https$" negate="true" />`.
     If a health probe hits `/healthz` or `/readyz` over plain HTTP, exempt them
     (`<match url="^(?!healthz|readyz).*" />`) or point the probe at HTTPS.
   - **nginx** — the `listen 80 { … return 308 https://$host$request_uri; }` block above.
   HSTS is already sent on HTTPS responses.
   *Verified:* `http://` → `301` to the HTTPS equivalent, path + query preserved,
   single hop to `200`, no loop.
2. **Gate or block `/metrics`.** It exposes operational + compliance-adjacent counts
   (identities, consent events, sync-lag laggards) with **no auth unless a token is
   set**. Either set **`METRICS_TOKEN`** (the app then requires it as a bearer token)
   **or block `/metrics` at the edge** and allow it only from your internal scrape
   source. Do not leave it open to the internet.
   - **IIS / ARR** — a URL Rewrite inbound rule returning 404 (hides the endpoint;
     place above the ARR proxy rule):
     ```xml
     <rule name="Block /metrics" stopProcessing="true">
       <match url="^metrics(/.*)?$" />
       <action type="CustomResponse" statusCode="404"
               statusReason="Not Found" statusDescription="Not Found" />
     </rule>
     ```
     To allow an internal scraper, add a negated `{REMOTE_ADDR}` condition (behind a
     proxy, use `{HTTP_X_FORWARDED_FOR}` instead — `{REMOTE_ADDR}` is the proxy IP).
   *Verified:* `/metrics`, `/Metrics`, `/metrics/`, `/metrics/foo`, `/metrics?x=1`
   all return `404` (IIS HTML, not the Prometheus text); `/api/status` still `401`,
   so only `/metrics` was affected.
3. **Strip `X-Powered-By`.** The app disables its own; the proxy adds
   `X-Powered-By: ARR/3.0` (tech fingerprinting). The `ARR/3.0` value is injected by
   ARR during proxying, so the simple `<customHeaders><remove>` often won't touch it
   — use a URL Rewrite **outbound** rule that blanks it regardless of source:
   ```xml
   <outboundRules>
     <rule name="Remove X-Powered-By" preCondition="">
       <match serverVariable="RESPONSE_X-Powered-By" pattern=".*" />
       <action type="Rewrite" value="" />
     </rule>
   </outboundRules>
   ```
   *Verified:* the response no longer discloses `ARR/3.0`. Note some IIS builds blank
   the value rather than deleting the header line, leaving an empty `x-powered-by:` —
   harmless (no version disclosed); an empty header is not a finding.
4. **Monitor TLS certificate expiry.** The `*.example.edu` wildcard cert is externally
   managed — add it to cert-expiry monitoring so a renewal never lapses (an expired
   cert + HSTS `includeSubDomains` = a no-click-through outage). *Open item on
   your-hub.example.edu as of 2026-09-16.*

---

## Process supervision (required)

The app **fails fast**: on an uncaught exception or unhandled promise rejection it
writes the stack synchronously to stderr (the "crash tracer") and **exits with code
1**. This is deliberate — after such a fault the process is in an undefined state,
and for a consent-enforcement service a clean restart is safer than serving from a
possibly-corrupt state (wrong data, half-open DB transactions, stale caches).

**Because the process exits on a fault, it MUST run under a supervisor that restarts
it** — otherwise a single fault takes the service down until someone restarts it by
hand. Configure whichever fits the host:

Run the app as `node.exe --import tsx src/api/server.ts` (the same `tsx` runtime as
`npm run dev`, but a single `node.exe` invocation that services prefer over
`npm.cmd`). IIS/ARR out front only *proxies* to the app — it does not supervise it.

**Windows Service via NSSM** (your-hub.example.edu) — [NSSM](https://nssm.cc/) restarts the
process on exit by default:

```powershell
# Elevated PowerShell. Adjust node path / app dir to your box.
nssm install ConsentHub "C:\Program Files\nodejs\node.exe" "--import tsx src/api/server.ts"
nssm set ConsentHub AppDirectory   "C:\path\to\optout-hub"
nssm set ConsentHub AppStdout      "C:\path\to\optout-hub\logs\out.log"
nssm set ConsentHub AppStderr      "C:\path\to\optout-hub\logs\err.log"   # crash tracer writes here
nssm set ConsentHub AppEnvironmentExtra NODE_ENV=production TRUST_PROXY=1  # or rely on .env
nssm set ConsentHub AppExit Default Restart          # restart on any exit (default)
nssm set ConsentHub AppRestartDelay 5000             # 5s between restarts
nssm set ConsentHub AppThrottle 10000                # crashes within 10s count as a crash-loop → NSSM backs off
nssm set ConsentHub Start SERVICE_AUTO_START
nssm start ConsentHub
# deploy from now on: git pull (+ npm install when deps change) → nssm restart ConsentHub
```

**Windows Service via WinSW** — same idea via a committed XML file (`consenthub.xml`
next to the downloaded `WinSW.exe`, renamed to `consenthub.exe`; then
`consenthub.exe install` / `start`):

```xml
<service>
  <id>ConsentHub</id>
  <name>Consent Hub</name>
  <description>Universal Opt-Out / Consent Hub</description>
  <executable>C:\Program Files\nodejs\node.exe</executable>
  <arguments>--import tsx src/api/server.ts</arguments>
  <workingdirectory>C:\path\to\optout-hub</workingdirectory>
  <env name="NODE_ENV" value="production"/>
  <env name="TRUST_PROXY" value="1"/>
  <log mode="roll-by-size"><sizeThreshold>10240</sizeThreshold><keepFiles>8</keepFiles></log>
  <!-- restart on any non-zero exit, with backoff; give up after repeated fast failures -->
  <onFailure action="restart" delay="5 sec"/>
  <onFailure action="restart" delay="10 sec"/>
  <resetFailure>1 hour</resetFailure>
  <startmode>Automatic</startmode>
</service>
```

**Linux (your eventual production)** — a **systemd** unit with `Restart=always`, or
**pm2**:
```ini
[Service]
ExecStart=/usr/bin/node --import tsx src/api/server.ts
WorkingDirectory=/opt/optout-hub
Restart=always
RestartSec=2
StartLimitIntervalSec=60
StartLimitBurst=5          # trip into failed state on a crash-loop instead of hammering
Environment=NODE_ENV=production
```

**Guard against crash loops.** Use the supervisor's backoff/limit (NSSM
`AppThrottle`, WinSW `resetFailure`, systemd `StartLimitBurst`, pm2 `max_restarts`)
so a persistent fault surfaces as a stopped service + alert rather than an infinite
restart storm. Point your monitoring at `/readyz` so a down/looping instance is
noticed.

**Verify supervision works.** Kill the process and confirm it comes back on its own:
```powershell
Stop-Process -Name node -Force
Start-Sleep -Seconds 8
Invoke-WebRequest -SkipHttpErrorCheck https://<host>/readyz | Select-Object StatusCode  # expect 200
```
Then confirm the crash-tracer line (`[uncaughtException] …` / `[diag] crash tracer
armed …`) is landing in the stderr log the supervisor captures.

## Quick checklist

- [ ] **Run mode chosen:** `ENABLE_OUTBOUND_WRITES` set correctly — `false` = test (receive only, no pushes; confirm the `outbound_writes_disabled` startup warning), `true` = production.
- [ ] **Process is supervised** with auto-restart on exit (the app fails fast on faults) — and the supervisor captures stderr (crash-tracer output).
- [ ] Proxy terminates TLS and `proxy_pass`es to the app on `127.0.0.1:<PORT>`.
- [ ] Proxy forwards `X-Forwarded-For` **and** `X-Forwarded-Proto`.
- [ ] App has `TRUST_PROXY` set (e.g. `1`) — verify logs now show real client IPs, not `127.0.0.1`.
- [ ] App port is firewalled from the internet (reachable only via the proxy).
- [ ] `WEBHOOK_PUBLIC_BASE` points at the external HTTPS URL.
- [ ] Dotfile/secret probes return `404`/`403` at the proxy (except `.well-known`).
- [ ] `/healthz` and `/readyz` reachable for load-balancer probes.
- [ ] **HTTP → HTTPS redirect enforced at the edge** (plain `http://` returns a 30x, not 200).
- [ ] **`/metrics` gated** (`METRICS_TOKEN` set) **or blocked at the edge** — not open to the internet.
- [ ] **`X-Powered-By` stripped** at the proxy; **TLS cert** in expiry monitoring.
