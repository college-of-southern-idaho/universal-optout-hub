import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { writeSync } from 'node:fs';
import { pool } from '../db.js';
import { loadAdapters, liveAdapterTypes, allAdapters, getAdapter } from '../adapters/registry.js';
import { ingest } from '../services/ingest.js';
import { decide, expireStale } from '../services/approvals.js';
import { reconcile } from '../services/reconciler.js';
import { pruneConsentChecks, pruneAuditLog } from '../services/retention.js';
import { startScheduler } from '../services/scheduler.js';
import { pollAll, pollSystem } from '../services/poller.js';
import { scanSyncLag, summarizeSyncLag } from '../services/alerting.js';
import { collectMetrics, renderPrometheus } from '../services/metrics.js';
import { readSecret, isProd } from '../core/config.js';
import { DEV_APP_SECRET } from '../core/secrets.js';
import { computeReadiness } from '../core/readiness.js';
import { resolveBranding } from '../core/branding.js';
import {
  lookupIdentity, searchAudit, auditFacets, syncLagReport,
  openLiabilityReport, activitySummary, packetToCsv, topologyAttributionReport,
  inboundStatus, deliveryMode, AUDIT_ACTOR_LABEL,
} from '../services/reporting.js';
import {
  getTopology, syncTopology, syncAllTopology, annotateCode, removeAnnotation,
} from '../services/topology.js';
import {
  listAdapterTypes, registerSystem, updateSystem, getCredentialMeta,
  setCredentials, clearCredential, testConnection,
  archiveSystem, unarchiveSystem, deleteSystem, HasHistoryError,
} from '../services/systems.js';
import { attachUser, requireRole, requireCsrf, requestLogger } from '../auth/middleware.js';
import { loginThrottleCheck, loginThrottleFailure, loginThrottleReset } from '../auth/login-throttle.js';
import { log } from '../core/logger.js';
import { requireApiKey, createApiKey, listApiKeys, revokeApiKey } from '../auth/apikeys.js';
import { requireRateLimit, setRateLimitStore } from '../auth/ratelimit.js';
import { createRedisRateLimitStore } from '../auth/ratelimit-redis.js';
import { checkConsent, listSuppressions, reportConsent, CheckRequestError } from '../services/consent-check.js';
import {
  mapTwilioInbound, mapTwilioEvents, routeTwilioEvent, verifyTwilioSignature, mapSendgridEvents, verifySendgridSignature,
  mapTelesignInbound, verifyTelesignSignature, withinClockSkew,
} from '../services/webhooks.js';
import { TwilioAdapter } from '../adapters/twilio.js';
import { markWebhookEventSeen } from '../services/webhook-dedup.js';
import { getDecryptedCredentials } from '../adapters/credential-store.js';
import { policy, hydratePolicy, configView, applyConfig } from '../core/policy.js';
import {
  hydrateCategories, categoryAdminView, upsertCategory, setCascade,
  archiveCategory, unarchiveCategory, deleteCategory, CategoryInUseError,
} from '../services/categories.js';
import { createSession, destroySession } from '../auth/sessions.js';
import {
  localLogin, createUser, setRole, setStatus, resetPassword, listUsers, type Role,
} from '../auth/users.js';
import { registerSsoRoutes, ssoProvidersEnabled } from '../auth/sso.js';

// Last-resort visibility. The structured logger writes to stdout/stderr via
// async .write(), which is buffered when output is a pipe (e.g. `npm run dev`)
// and can be LOST if the process exits immediately after. So crash diagnostics
// go out SYNCHRONOUSLY with fs.writeSync(fd 2) — guaranteed to flush before the
// process is gone. `exit` traces the code for any normal exit; a signal kill
// (SIGKILL/OOM) won't fire it, which itself narrows the cause.
const diag = (msg: string): void => {
  try { writeSync(2, msg.endsWith('\n') ? msg : msg + '\n'); } catch { /* nothing else to do */ }
};
// Fail fast (Node best practice): after an uncaught exception or unhandled
// rejection the process is in an UNDEFINED state — in-memory caches, open DB
// transactions, and adapter state may be inconsistent. For a consent-enforcement
// service, continuing to serve from that state risks a WRONG consent decision,
// which is worse than a brief restart. So we log the fault SYNCHRONOUSLY (diag,
// above — guaranteed to flush) and then exit(1) for a clean restart.
//
// ⚠ REQUIRES PROCESS SUPERVISION: because the process now exits on a fault, it
// MUST run under a supervisor that restarts it (Windows Service/iisnode with
// auto-recycle, systemd `Restart=always`, pm2, etc.). Without one, a fault takes
// the service down until a manual restart. See DEPLOYMENT.md "Process supervision".
process.on('uncaughtException', (err: any) => {
  diag(`[uncaughtException] ${err?.stack ?? err?.message ?? String(err)}`);
  log.error('uncaught_exception', { error: err?.message ?? String(err) });
  process.exit(1);
});
process.on('unhandledRejection', (reason: any) => {
  diag(`[unhandledRejection] ${reason?.stack ?? reason?.message ?? String(reason)}`);
  log.error('unhandled_rejection', { error: reason?.message ?? String(reason) });
  process.exit(1);
});
process.on('exit', (code) => diag(`[exit] process exiting, code=${code}`));
diag('[diag] crash tracer armed (fail-fast; requires a restart supervisor)');

export const app = express();
app.disable('x-powered-by'); // don't advertise the framework

/** Constant-time string equality (tolerates unequal lengths). */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// Behind a reverse proxy (TLS terminator), set TRUST_PROXY so req.ip / req.protocol
// reflect the client, not the proxy — e.g. TRUST_PROXY=1 (one hop) or "loopback".
const trustProxy = process.env.TRUST_PROXY;
if (trustProxy) app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);

// Enforce HTTPS: redirect plaintext requests to https and send HSTS. On by
// default in production; override with FORCE_HTTPS=1/0. The app is HTTP behind a
// TLS terminator, so req.secure reflects the CLIENT only when TRUST_PROXY is
// set — required here, otherwise every request looks plaintext and the redirect
// loops. Local dev over http is unaffected unless FORCE_HTTPS is set.
const forceHttps = process.env.FORCE_HTTPS
  ? /^(1|true|yes|on)$/i.test(process.env.FORCE_HTTPS)
  : process.env.NODE_ENV === 'production';
if (forceHttps && !trustProxy) {
  log.warn('force_https_without_trust_proxy', {
    detail: 'HTTPS enforcement is on but TRUST_PROXY is unset — behind a TLS-terminating proxy this causes a redirect loop. Set TRUST_PROXY.',
  });
}

// First in the chain: assign a request id and emit a structured access-log line
// on finish (so latency covers the whole request).
app.use(requestLogger);

// Redirect any plaintext HTTP request to HTTPS (before body parsing, so we don't
// read a request we're bouncing). Health/readiness are exempt — load balancers
// probe them over plain HTTP. 308 preserves the method and body on retry.
const HTTPS_EXEMPT = new Set(['/healthz', '/readyz']);
if (forceHttps) {
  app.use((req, res, next) => {
    if (req.secure || HTTPS_EXEMPT.has(req.path)) { next(); return; }
    res.redirect(308, `https://${req.headers.host}${req.originalUrl}`);
  });
}

// Security headers (hand-rolled, no dependency). Console JS is served as an
// external file (web/app.js) with all event handlers bound via delegation, so
// script-src needs no 'unsafe-inline'. Inline styles remain (the page
// uses style="" attributes), so style-src keeps 'unsafe-inline'.
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  );
  // HSTS: tell browsers to only ever use HTTPS for this origin. Tied to the same
  // switch as the redirect so the two are consistent. Not sent in plain-HTTP dev.
  if (forceHttps) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// API responses are dynamic and per-user (and often sensitive). A caching proxy
// or the browser must never serve a stale copy — a cached GET /api/systems is
// what makes a just-deleted service still appear in the console, so acting on it
// fails with a confusing "unknown system". Force no-store on every API response.
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// Capture the raw body so webhook signatures (e.g. SendGrid Ed25519) can be
// verified over the exact bytes, while still parsing JSON for handlers.
app.use(express.json({ limit: '2mb', verify: (req, _res, buf) => { (req as { rawBody?: Buffer }).rawBody = buf; } }));
app.use(express.urlencoded({ extended: false })); // dev mock SSO form + Twilio webhooks

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express { interface Request { rawBody?: Buffer } }
}
app.use(attachUser);
// CSRF guard: enforced only on cookie-session (console) mutating requests;
// API-key and signature-verified webhook routes carry no session and pass through.
app.use(requireCsrf);

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web');
app.use(express.static(webDir));

// ---- Health / readiness (public, unauthenticated) --------------------------
// Liveness: the process is up. Readiness: the process can reach the database.
// Load balancers / orchestrators poll these; keep them dependency-light.
app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

app.get('/readyz', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ready' });
  } catch (e: any) {
    res.status(503).json({ status: 'not ready', error: e.message });
  }
});

// Prometheus-style metrics (pull model). Typically scraped over an internal
// network; if METRICS_TOKEN is set, require it as a bearer token (a scrape
// config supplies it). Left open when unset so a local/dev scrape just works.
app.get('/metrics', async (req, res) => {
  const token = readSecret('METRICS_TOKEN');
  if (token) {
    const auth = req.get('authorization') ?? '';
    const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!timingSafeEqualStr(presented, token)) return res.status(401).type('text/plain').send('unauthorized\n');
  }
  try {
    const body = renderPrometheus(await collectMetrics());
    res.type('text/plain; version=0.0.4').send(body);
  } catch (e: any) {
    log.error('metrics_collection_failed', { reqId: req.id, error: e.message });
    res.status(500).type('text/plain').send('# metrics collection failed\n');
  }
});

// ---- Auth ------------------------------------------------------------------

app.get('/api/auth/providers', (_req, res) => {
  res.json({ local: true, sso: ssoProvidersEnabled() });
});

app.post('/api/auth/login', async (req, res) => {
  const ip = req.ip ?? 'unknown';
  // Per-IP throttle (defense-in-depth over the per-account lockout): stops one
  // address spraying many accounts. Only failed attempts count toward it.
  const gate = loginThrottleCheck(ip);
  if (!gate.allowed) {
    res.setHeader('Retry-After', String(gate.retryAfterSec));
    log.warn('login_throttled', { reqId: req.id, ip, retryAfterSec: gate.retryAfterSec });
    res.status(429).json({
      error: 'too many failed sign-in attempts from this address — try again later',
      retry_after_seconds: gate.retryAfterSec,
    });
    return;
  }
  const { username, password } = req.body ?? {};
  if (!username || !password) {
    res.status(400).json({ error: 'username and password required' });
    return;
  }
  const result = await localLogin(String(username), String(password));
  if (!result.ok) {
    loginThrottleFailure(ip);
    res.status(401).json({ error: result.reason });
    return;
  }
  loginThrottleReset(ip);
  await createSession(req, res, result.userId);
  res.json({ ok: true });
});

app.post('/api/auth/logout', async (req, res) => {
  await destroySession(req, res);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.user) {
    res.status(401).json({ error: 'not signed in' });
    return;
  }
  // The console reads csrf_token here and echoes it in X-CSRF-Token on writes.
  // `mode` drives the run-mode banner (test mode / non-production) for all roles.
  res.json({
    ...req.user,
    csrf_token: req.csrfToken,
    mode: { enableOutboundWrites: policy.enableOutboundWrites, production: isProd() },
  });
});

registerSsoRoutes(app);

// ---- User administration (admin only) ---------------------------------------

app.get('/api/users', requireRole('admin'), async (_req, res) => {
  res.json(await listUsers());
});

app.post('/api/users', requireRole('admin'), async (req, res) => {
  try {
    const { username, display_name, email, role, password } = req.body ?? {};
    const id = await createUser(
      { username, display_name, email, role: (role ?? 'viewer') as Role, password },
      { id: req.user!.id, name: req.user!.username },
    );
    res.json({ id });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

app.patch('/api/users/:id', requireRole('admin'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const by = { id: req.user!.id, name: req.user!.username };
    if (id === req.user!.id && (req.body.role || req.body.status === 'disabled')) {
      res.status(400).json({ error: 'cannot change your own role or disable yourself' });
      return;
    }
    if (req.body.role) await setRole(id, req.body.role as Role, by);
    if (req.body.status) await setStatus(id, req.body.status, by);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/users/:id/password', requireRole('admin'), async (req, res) => {
  try {
    await resetPassword(Number(req.params.id), String(req.body.password ?? ''), {
      id: req.user!.id,
      name: req.user!.username,
    });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// ---- Consent hub API (role-gated) -------------------------------------------
// viewer: read · operator: ingest events, run reconciler · approver: decide reviews

app.get('/api/systems', requireRole('viewer'), async (req, res) => {
  // Archived services are hidden from the operational views by default; their
  // consent history still lives in consent_events/consent_states and so remains
  // in all reports. Pass ?includeArchived=1 to list them (the Services admin
  // screen's "show archived" toggle).
  const includeArchived = req.query.includeArchived === '1' || req.query.includeArchived === 'true';
  const r = await pool.query(
    includeArchived
      ? 'SELECT * FROM systems ORDER BY id'
      : 'SELECT * FROM systems WHERE archived_at IS NULL ORDER BY id',
  );
  res.json(r.rows);
});

// ---- Branding (read: any signed-in user · write: admin) ---------------------
// Public: branding is non-sensitive presentation data, and the login screen
// (rendered before auth) needs it to brand itself.
app.get('/api/branding', async (_req, res) => {
  const r = await pool.query(
    `SELECT org_name, browser_title, logo_data, favicon_data, accent_color, bg_color,
            header_color, text_color, card_color, optin_color, optout_color, suppressed_color, updated_at
       FROM app_branding WHERE id=1`,
  );
  res.json(r.rows[0] ?? {});
});

app.put('/api/branding', requireRole('admin'), async (req, res) => {
  try {
    const b = resolveBranding(req.body ?? {});
    await pool.query(
      `UPDATE app_branding
          SET org_name=$1, browser_title=$2, logo_data=$3, favicon_data=$4,
              accent_color=$5, bg_color=$6, header_color=$7, text_color=$8, card_color=$9,
              optin_color=$10, optout_color=$11, suppressed_color=$12,
              updated_at=now(), updated_by=$13
        WHERE id=1`,
      [
        b.org_name, b.browser_title, b.logo_data, b.favicon_data,
        b.accent_color, b.bg_color, b.header_color, b.text_color, b.card_color,
        b.optin_color, b.optout_color, b.suppressed_color, req.user!.username,
      ],
    );
    res.json(b);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// ---- Runtime configuration (admin) -----------------------------------------
// The tunable policy/operational knobs, DB-backed and editable in the console.
// Secrets are not here. GET returns metadata + current values; PUT validates and
// applies, reloading the scheduler if an interval changed.
app.get('/api/config', requireRole('admin'), (_req, res) => {
  res.json(configView());
});

app.put('/api/config', requireRole('admin'), async (req, res) => {
  try {
    const result = await applyConfig(req.body ?? {}, req.user!.username);
    if (result.reloadScheduler) startScheduler();
    res.json({ ok: true, ...result });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// ---- Message categories + opt-out cascade matrix (admin) -------------------
// Data-driven categories drive opt-out propagation (DESIGN.md §10). A protected
// category is never a cascade target. Every write refreshes the live matrix and
// returns the current view.
app.get('/api/categories', requireRole('admin'), async (_req, res) => {
  res.json(await categoryAdminView());
});

app.post('/api/categories', requireRole('admin'), async (req, res) => {
  const b = req.body ?? {};
  try {
    await upsertCategory(String(b.key ?? ''), String(b.label ?? ''), !!b.protected,
      Number(b.sort_order ?? 100), { id: req.user!.id, name: req.user!.username });
    res.json(await categoryAdminView());
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.post('/api/categories/cascade', requireRole('admin'), async (req, res) => {
  const b = req.body ?? {};
  try {
    await setCascade(String(b.source ?? ''), String(b.target ?? ''), !!b.on,
      { id: req.user!.id, name: req.user!.username });
    res.json(await categoryAdminView());
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.post('/api/categories/:key/archive', requireRole('admin'), async (req, res) => {
  try {
    await archiveCategory(String(req.params.key), { id: req.user!.id, name: req.user!.username });
    res.json(await categoryAdminView());
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.post('/api/categories/:key/unarchive', requireRole('admin'), async (req, res) => {
  try {
    await unarchiveCategory(String(req.params.key), { id: req.user!.id, name: req.user!.username });
    res.json(await categoryAdminView());
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Hard delete — refused with 409 if any service uses the category (archive instead).
app.delete('/api/categories/:key', requireRole('admin'), async (req, res) => {
  try {
    await deleteCategory(String(req.params.key), { id: req.user!.id, name: req.user!.username });
    res.json({ deleted: true });
  } catch (e: any) {
    if (e instanceof CategoryInUseError) res.status(409).json({ error: e.message, code: e.code });
    else res.status(400).json({ error: e.message });
  }
});

// ---- Service configuration (admin) -----------------------------------------
// Phase 1 of the two-phase flow: register a sending service, store its
// credentials write-only, and test the connection. Phase 2 (discover & review)
// reuses the topology routes below. Compliance: nothing here is read by a
// consent decision (ADR-0002 §2.2); credentials are never returned.

app.get('/api/adapter-types', requireRole('admin'), (_req, res) => {
  const live = new Set(liveAdapterTypes());
  res.json(listAdapterTypes().map((s) => ({ ...s, live: live.has(s.type) })));
});

app.post('/api/systems', requireRole('admin'), async (req, res) => {
  try {
    res.json(await registerSystem(req.body ?? {}, { id: req.user!.id, name: req.user!.username }));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

app.patch('/api/systems/:id', requireRole('admin'), async (req, res) => {
  try {
    res.json(await updateSystem(String(req.params.id), req.body ?? {}, { id: req.user!.id, name: req.user!.username }));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Credential metadata only — which keys are set, a last-4 hint. Never the secret.
app.get('/api/systems/:id/credentials', requireRole('admin'), async (req, res) => {
  res.json(await getCredentialMeta(String(req.params.id)));
});

// Write-only: accepts { credentials: [{ key, value }] }; blanks are ignored.
app.put('/api/systems/:id/credentials', requireRole('admin'), async (req, res) => {
  try {
    const entries = Array.isArray(req.body?.credentials) ? req.body.credentials : [];
    res.json(await setCredentials(String(req.params.id), entries, { id: req.user!.id, name: req.user!.username }));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/systems/:id/credentials/:key', requireRole('admin'), async (req, res) => {
  const removed = await clearCredential(String(req.params.id), String(req.params.key), { id: req.user!.id, name: req.user!.username });
  res.json({ removed });
});

app.post('/api/systems/:id/test', requireRole('admin'), async (req, res) => {
  try {
    res.json(await testConnection(String(req.params.id), { id: req.user!.id, name: req.user!.username }));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Point a platform's inbound consent webhook at this hub (admin). Requires
// WEBHOOK_PUBLIC_BASE — the configured URL must be reachable by the platform AND
// match what the hub verifies signatures against. Only adapters that implement
// provisionInboundWebhook (Twilio) support it.
app.post('/api/systems/:id/provision-webhook', requireRole('admin'), async (req, res) => {
  const systemId = String(req.params.id);
  const base = process.env.WEBHOOK_PUBLIC_BASE?.replace(/\/+$/, '');
  if (!base) {
    res.status(400).json({ error: 'set WEBHOOK_PUBLIC_BASE to your public hub URL first — it must be reachable by the platform and match the webhook signature' });
    return;
  }
  let adapter;
  try {
    adapter = getAdapter(systemId);
  } catch {
    res.status(404).json({ error: 'no such system (save and set credentials first)' });
    return;
  }
  if (typeof adapter.provisionInboundWebhook !== 'function') {
    res.status(400).json({ error: 'this platform does not support automatic webhook provisioning' });
    return;
  }
  // Same shape the inbound route + signature check use: /api/webhooks/<type>/<id>.
  const publicUrl = `${base}/api/webhooks/${encodeURIComponent(adapter.system.adapter_type)}/${encodeURIComponent(systemId)}`;
  const result = await adapter.provisionInboundWebhook(publicUrl);
  await pool.query(
    `INSERT INTO audit_log (actor, action, detail) VALUES ($1,'system.provision_webhook',$2)`,
    [req.user!.username, { system_id: systemId, url: publicUrl, ok: result.ok }],
  ).catch(() => {});
  // 200 with an ok flag (like the connection test) so the client can show the
  // detail on failure; 4xx is reserved for the precondition errors above.
  res.json({ ...result, url: publicUrl });
});

app.post('/api/systems/:id/archive', requireRole('admin'), async (req, res) => {
  try {
    res.json(await archiveSystem(String(req.params.id), { id: req.user!.id, name: req.user!.username }));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/systems/:id/unarchive', requireRole('admin'), async (req, res) => {
  try {
    res.json(await unarchiveSystem(String(req.params.id), { id: req.user!.id, name: req.user!.username }));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Hard delete — refused with 409 if the system has consent history (archive instead).
app.delete('/api/systems/:id', requireRole('admin'), async (req, res) => {
  try {
    await deleteSystem(String(req.params.id), { id: req.user!.id, name: req.user!.username });
    res.json({ deleted: true });
  } catch (e: any) {
    if (e instanceof HasHistoryError) {
      res.status(409).json({ error: e.message, code: e.code });
    } else {
      res.status(400).json({ error: e.message });
    }
  }
});

// ---- Service API keys (admin) — for the consent-check API (ADR-0004) --------

app.get('/api/systems/:id/api-keys', requireRole('admin'), async (req, res) => {
  res.json(await listApiKeys(String(req.params.id)));
});

// Returns the plaintext key ONCE. It is never retrievable again.
app.post('/api/systems/:id/api-keys', requireRole('admin'), async (req, res) => {
  const label = String(req.body?.label ?? '').trim() || 'unnamed';
  // Optional per-key rate override; blank/absent → hub default. A value of 0
  // disables limiting for this key (ADR-0004 §8). Reject other invalid input.
  const raw = req.body?.rate_limit_per_sec;
  let rate: number | null = null;
  if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      res.status(400).json({ error: 'rate_limit_per_sec must be a non-negative integer (or omitted)' });
      return;
    }
    rate = n;
  }
  const { id, plaintext, prefix } = await createApiKey(
    String(req.params.id), label, req.user!.username, rate,
  );
  res.status(201).json({
    id, key: plaintext, prefix,
    note: 'Copy this key now — it will not be shown again.',
  });
});

app.delete('/api/systems/:id/api-keys/:keyId', requireRole('admin'), async (req, res) => {
  const ok = await revokeApiKey(String(req.params.id), Number(req.params.keyId), req.user!.username);
  res.status(ok ? 200 : 404).json({ ok });
});

// ---- Consent-check API (machine-authed; ADR-0004 §2.2) ----------------------

app.post('/api/v1/consent/check', requireApiKey, requireRateLimit(policy.consentCheckRateLimitPerSec), async (req, res) => {
  const { system, channel, identities } = req.body ?? {};
  if (!system || !channel || !Array.isArray(identities)) {
    res.status(400).json({ error: 'system, channel, and identities[] are required' });
    return;
  }
  if (identities.length < 1 || identities.length > 1000) {
    res.status(400).json({ error: 'identities must contain 1..1000 entries' });
    return;
  }
  // A key may only check its own system (ADR-0004 §2.3).
  if (req.apiKey!.system_id !== String(system)) {
    res.status(403).json({ error: 'API key is not scoped to this system' });
    return;
  }
  try {
    const results = await checkConsent(
      String(system), String(channel), identities.map(String),
      policy.consentCheckMode, req.apiKey!.id,
    );
    res.json({ results });
  } catch (e: any) {
    if (e instanceof CheckRequestError) {
      res.status(400).json({ error: e.message });
    } else {
      res.status(500).json({ error: 'consent check failed' });
    }
  }
});

// Suppression sync feed for a sender's local cache (ADR-0004 §2.4/§6). Same
// machine auth, scope, and rate limit as the check endpoint. Without ?since the
// caller gets the current suppression baseline; with ?since=<ISO> it gets the
// delta of rows changed after that instant. The returned `as_of` is the cursor
// for the next call.
app.get('/api/v1/consent/suppressions', requireApiKey, requireRateLimit(policy.consentCheckRateLimitPerSec), async (req, res) => {
  const system = String(req.query.system ?? '');
  if (!system) {
    res.status(400).json({ error: 'system query parameter is required' });
    return;
  }
  if (req.apiKey!.system_id !== system) {
    res.status(403).json({ error: 'API key is not scoped to this system' });
    return;
  }
  const since = req.query.since === undefined ? undefined : String(req.query.since);
  try {
    res.json(await listSuppressions(system, since, new Date().toISOString()));
  } catch (e: any) {
    if (e instanceof CheckRequestError) {
      res.status(400).json({ error: e.message });
    } else {
      res.status(500).json({ error: 'suppression feed failed' });
    }
  }
});

// Report a consent event a sender observed (e.g. a Twilio STOP its own inbound
// webhook received), scoped to the key's own system. The write counterpart to
// the check API: lets a sender feed opt-outs to the hub WITHOUT repointing the
// platform's inbound webhook away from its app. Ingests like a hub webhook, so
// propagation, precedence, and audit are identical. Same machine auth + limit.
app.post('/api/v1/consent/report', requireApiKey, requireRateLimit(policy.consentCheckRateLimitPerSec), async (req, res) => {
  const { system, value, direction, occurred_at, source } = req.body ?? {};
  if (!system || !value || !direction) {
    res.status(400).json({ error: 'system, value, and direction ("opt_out"|"opt_in") are required' });
    return;
  }
  if (req.apiKey!.system_id !== String(system)) {
    res.status(403).json({ error: 'API key is not scoped to this system' });
    return;
  }
  try {
    res.json(await reportConsent(String(system), { value: String(value), direction, occurred_at, source }));
  } catch (e: any) {
    if (e instanceof CheckRequestError) {
      res.status(400).json({ error: e.message });
    } else {
      log.error('consent_report_failed', { reqId: req.id, error: e.message });
      res.status(500).json({ error: 'consent report failed' });
    }
  }
});

// ---- Inbound platform webhooks → ingest (signature-gated, public) -----------

// Reconstruct the exact public URL the platform signed against. Behind a proxy,
// set WEBHOOK_PUBLIC_BASE (e.g. https://hub.example.edu) so it matches.
function webhookUrl(req: express.Request): string {
  const base = process.env.WEBHOOK_PUBLIC_BASE?.replace(/\/+$/, '');
  return base ? base + req.originalUrl : `${req.protocol}://${req.get('host')}${req.originalUrl}`;
}

// Twilio inbound SMS (STOP/START). Verified with the system's auth_token.
app.post('/api/webhooks/twilio/:systemId', async (req, res) => {
  const systemId = String(req.params.systemId);
  try {
    const creds = await getDecryptedCredentials(systemId);
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.body ?? {})) params[k] = String(v);
    if (!verifyTwilioSignature(creds.auth_token ?? '', webhookUrl(req), params, req.header('x-twilio-signature'))) {
      res.status(403).json({ error: 'invalid Twilio signature' });
      return;
    }
    const mapped = mapTwilioInbound(params);
    if (!mapped) { res.json({ ok: true, ignored: 'not a consent keyword' }); return; }
    // Replay/retry dedup on Twilio's MessageSid (Twilio signs no timestamp, so
    // dedup is the replay defense here — the SID is inside the signed params).
    if (mapped.eventId && !(await markWebhookEventSeen(mapped.eventId))) {
      res.json({ ok: true, ignored: 'duplicate event' });
      return;
    }
    await ingest({
      system_id: systemId,
      identity_value: mapped.identity,
      direction: mapped.direction,
      occurred_at: mapped.occurred_at,
      source_detail: mapped.detail,
      ...(mapped.direction === 'opt_in' ? { evidence: { method: mapped.detail } } : {}),
    });
    res.json({ ok: true, direction: mapped.direction });
  } catch (e: any) {
    log.error('webhook_error', { reqId: req.id, path: req.path, error: e.message });
    res.status(500).json({ error: 'webhook processing failed' });
  }
});

// Twilio Event Streams inbound-message sink. An ADDITIVE path: subscribe to
// `com.twilio.messaging.inbound-message.received` and point the Sink here, and
// Twilio streams a copy of every inbound message (with optOutType) in PARALLEL to
// each Messaging Service's own inbound webhook — so opt-outs land in the hub even
// when that webhook is owned by a third-party app we can't repoint. One account-
// level subscription covers every Messaging Service. Event Streams sinks aren't
// request-signed like messaging webhooks, so we authenticate with a shared token
// (TWILIO_EVENTS_TOKEN) carried in the Sink URL (?token=) or an x-events-token
// header. Each event is routed to the system whose Messaging Service SID matches
// (payload `messagingServiceSid`), so each Messaging Service keeps its own
// category; :systemId is the fallback when the SID isn't a registered system.
app.post('/api/webhooks/twilio-events/:systemId', async (req, res) => {
  const systemId = String(req.params.systemId);
  const token = readSecret('TWILIO_EVENTS_TOKEN');
  if (!token) { res.status(503).json({ error: 'TWILIO_EVENTS_TOKEN not configured' }); return; }
  const presented = String(req.query.token ?? req.header('x-events-token') ?? '');
  if (!timingSafeEqualStr(presented, token)) { res.status(403).json({ error: 'invalid token' }); return; }
  try {
    const events = mapTwilioEvents(req.body);
    // Map each active Twilio system's Messaging Service SID → system id, so an
    // account-level Event Streams feed routes each event to the right system.
    const msSidToSystem = new Map<string, string>();
    for (const a of allAdapters()) {
      if (a instanceof TwilioAdapter && a.messagingServiceId) msSidToSystem.set(a.messagingServiceId, a.system.id);
    }
    let ingested = 0;
    for (const e of events) {
      // Dedup on Twilio's messageSid: sinks retry on non-2xx and may redeliver,
      // and the same message can also arrive via a per-service webhook.
      if (e.eventId && !(await markWebhookEventSeen(e.eventId))) continue;
      await ingest({
        system_id: routeTwilioEvent(e.routeMsSid, msSidToSystem, systemId),
        identity_value: e.identity,
        direction: e.direction,
        occurred_at: e.occurred_at,
        source_detail: e.detail,
        ...(e.direction === 'opt_in' ? { evidence: { method: e.detail } } : {}),
      });
      ingested++;
    }
    res.json({ ok: true, ingested });
  } catch (e: any) {
    log.error('webhook_error', { reqId: req.id, path: req.path, error: e.message });
    res.status(500).json({ error: 'event processing failed' });
  }
});

// SendGrid Event Webhook (unsubscribe / spamreport / group_(un)subscribe).
// Verified with the system's stored Ed25519 event-webhook key.
app.post('/api/webhooks/sendgrid/:systemId', async (req, res) => {
  const systemId = String(req.params.systemId);
  try {
    const creds = await getDecryptedCredentials(systemId);
    const ok = verifySendgridSignature(
      creds.event_webhook_key ?? '',
      req.rawBody ?? Buffer.alloc(0),
      req.header('x-twilio-email-event-webhook-signature'),
      req.header('x-twilio-email-event-webhook-timestamp'),
    );
    if (!ok) { res.status(403).json({ error: 'invalid SendGrid signature' }); return; }
    // Replay defense: reject a stale signed timestamp (the signature covers it).
    const sgTsMs = Number(req.header('x-twilio-email-event-webhook-timestamp')) * 1000;
    if (!withinClockSkew(sgTsMs, Date.now(), policy.webhookMaxSkewSeconds)) {
      res.status(403).json({ error: 'stale webhook timestamp' });
      return;
    }
    const events = mapSendgridEvents(req.body);
    let ingested = 0;
    for (const e of events) {
      // Per-event dedup on sg_event_id (a retry/replay re-sends the same ids).
      if (e.eventId && !(await markWebhookEventSeen(e.eventId))) continue;
      await ingest({
        system_id: systemId,
        identity_value: e.identity,
        direction: e.direction,
        occurred_at: e.occurred_at,
        source_detail: e.detail,
        ...(e.direction === 'opt_in' ? { evidence: { method: e.detail } } : {}),
      });
      ingested++;
    }
    res.json({ ok: true, ingested });
  } catch (e: any) {
    log.error('webhook_error', { reqId: req.id, path: req.path, error: e.message });
    res.status(500).json({ error: 'webhook processing failed' });
  }
});

// Telesign inbound MO callback (STOP/START). Verified with the system's api_key
// (HMAC-SHA256 over the raw body; TSA authorization header).
app.post('/api/webhooks/telesign/:systemId', async (req, res) => {
  const systemId = String(req.params.systemId);
  try {
    const creds = await getDecryptedCredentials(systemId);
    const authHeader = req.header('x-ts-authorization') ?? req.header('authorization');
    if (!verifyTelesignSignature(creds.api_key ?? '', req.rawBody ?? Buffer.alloc(0), authHeader)) {
      res.status(403).json({ error: 'invalid Telesign signature' });
      return;
    }
    // Replay defense: reject a stale signed timestamp when present (it's in the
    // signed body), then dedup on reference_id.
    const tsRaw = (req.body as { submit_timestamp?: string })?.submit_timestamp;
    if (tsRaw && !withinClockSkew(Date.parse(tsRaw), Date.now(), policy.webhookMaxSkewSeconds)) {
      res.status(403).json({ error: 'stale webhook timestamp' });
      return;
    }
    const mapped = mapTelesignInbound(req.body);
    if (!mapped) { res.json({ ok: true, ignored: 'not a consent action' }); return; }
    if (mapped.eventId && !(await markWebhookEventSeen(mapped.eventId))) {
      res.json({ ok: true, ignored: 'duplicate event' });
      return;
    }
    await ingest({
      system_id: systemId,
      identity_value: mapped.identity,
      direction: mapped.direction,
      occurred_at: mapped.occurred_at,
      source_detail: mapped.detail,
      ...(mapped.direction === 'opt_in' ? { evidence: { method: mapped.detail } } : {}),
    });
    res.json({ ok: true, direction: mapped.direction });
  } catch (e: any) {
    log.error('webhook_error', { reqId: req.id, path: req.path, error: e.message });
    res.status(500).json({ error: 'webhook processing failed' });
  }
});

app.get('/api/identities', requireRole('viewer'), async (_req, res) => {
  const r = await pool.query(
    `SELECT i.id, i.kind, i.value_normalized, i.value_raw,
            COALESCE(json_agg(json_build_object(
              'system_id', cs.system_id, 'state', cs.state, 'provenance', cs.provenance)
              ORDER BY cs.system_id)
              FILTER (WHERE cs.system_id IS NOT NULL), '[]') AS states
       FROM identities i
       LEFT JOIN consent_states cs ON cs.identity_id = i.id
      GROUP BY i.id ORDER BY i.id DESC`,
  );
  res.json(r.rows);
});

app.get('/api/identities/:id/events', requireRole('viewer'), async (req, res) => {
  const r = await pool.query(
    `SELECT e.*, ev.method AS evidence_method, ev.consent_language, u.username AS actor_username
       FROM consent_events e
       LEFT JOIN evidence ev ON ev.id = e.evidence_id
       LEFT JOIN users u ON u.id = e.actor_user_id
      WHERE e.identity_id=$1
      ORDER BY e.occurred_at, e.id`,
    [req.params.id],
  );
  res.json(r.rows);
});

app.post('/api/events', requireRole('operator'), async (req, res) => {
  try {
    const body = req.body;
    if (body.occurred_at) body.occurred_at = new Date(body.occurred_at);
    body.actor = req.user!.username;        // attribution comes from the session,
    body.actor_user_id = req.user!.id;      // never from the request body
    const result = await ingest(body);
    res.json(result);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/approvals', requireRole('viewer'), async (req, res) => {
  await expireStale();
  const status = (req.query.status as string) ?? 'pending';
  const r = await pool.query(
    `SELECT ar.*, i.value_normalized, iu.username AS initiated_by_username,
            (SELECT json_agg(json_build_object(
               'system_id', at.system_id, 'preselected', at.preselected,
               'selected', at.selected, 'snapshot_state', at.snapshot_state,
               'snapshot_provenance', at.snapshot_provenance, 'outcome', at.outcome)
               ORDER BY at.system_id)
               FROM approval_targets at WHERE at.request_id = ar.id) AS targets,
            (SELECT json_agg(json_build_object(
               'event_id', e.id, 'system_id', e.system_id, 'occurred_at', e.occurred_at,
               'source_detail', e.source_detail, 'evidence_method', ev.method,
               'consent_language', ev.consent_language) ORDER BY e.occurred_at)
               FROM approval_request_events are2
               JOIN consent_events e ON e.id = are2.event_id
               LEFT JOIN evidence ev ON ev.id = e.evidence_id
              WHERE are2.request_id = ar.id) AS originating_events
       FROM approval_requests ar
       JOIN identities i ON i.id = ar.identity_id
       LEFT JOIN users iu ON iu.id = ar.initiated_by_user_id
      WHERE ($1 = 'all' OR ar.status = $1)
      ORDER BY ar.created_at DESC`,
    [status],
  );
  res.json(r.rows);
});

app.post('/api/approvals/:id/decide', requireRole('approver'), async (req, res) => {
  try {
    const result = await decide({
      requestId: Number(req.params.id),
      version: req.body.version,
      outcome: req.body.outcome,
      selectedTargets: req.body.selectedTargets ?? [],
      attestationText: req.body.attestationText ?? '',
      decidedBy: req.user!.username,          // from session, not body
      decidedByUserId: req.user!.id,
      note: req.body.note,
    });
    res.json(result);
  } catch (e: any) {
    res.status(e.code === 'VERSION_CONFLICT' ? 409 : 400).json({ error: e.message });
  }
});

app.post('/api/reconcile', requireRole('operator'), async (_req, res) => {
  res.json(await reconcile());
});

// Pull inbound opt-out/opt-in events from poll-delivery platforms (no webhook)
// and ingest them. On-demand like the reconciler; the scheduler also runs it
// (POLL_INTERVAL_MINUTES).
app.post('/api/poll', requireRole('operator'), async (_req, res) => {
  res.json(await pollAll());
});

// Poll a single poll-delivery system on demand (operator). 404 if the system
// has no live adapter, 400 if that adapter doesn't support polling (webhook- or
// outbound-only). Backs the per-system "Poll now" button in the System view.
app.post('/api/poll/:systemId', requireRole('operator'), async (req, res) => {
  let adapter;
  try {
    adapter = getAdapter(String(req.params.systemId));
  } catch {
    return res.status(404).json({ error: 'no such system' });
  }
  if (typeof adapter.pollOptOuts !== 'function') {
    return res.status(400).json({ error: 'system is not poll-delivery' });
  }
  res.json(await pollSystem(adapter));
});

// Per-system inbound status (operator): delivery mode, last inbound event, last
// poll, and 30-day inbound volume. Delivery mode is derived from the live
// adapter (poll-capable) or the known webhook adapter types.
app.get('/api/inbound-status', requireRole('operator'), async (_req, res) => {
  const rows = await inboundStatus();
  const pollable = new Set(
    allAdapters().filter((a) => typeof a.pollOptOuts === 'function').map((a) => a.system.id),
  );
  res.json(rows.map((r) => ({
    id: r.id,
    name: r.name,
    adapter_type: r.adapter_type,
    delivery: deliveryMode(pollable.has(r.id), r.adapter_type),
    lastInboundAt: r.last_inbound_at,
    lastPolledAt: r.last_polled_at,
    inbound30d: r.inbound_30d,
  })));
});

// Run a sync-lag scan now: report → summarize → audit + optional webhook
// dispatch. The scheduler also runs this (ALERT_SCAN_INTERVAL_MINUTES); this
// route lets an operator trigger it on demand. Returns the alert, or
// { alert: null } when nothing is lagging.
app.post('/api/alerts/scan', requireRole('operator'), async (_req, res) => {
  res.json({ alert: await scanSyncLag() });
});

// Operator-facing system status: scheduler config, live sync-lag summary, open
// liability counts, and the last scheduled reconcile/alert timestamps. Backs the
// console's System view; a single snapshot, computed on request.
app.get('/api/status', requireRole('operator'), async (_req, res) => {
  const [liability, lastRuns] = await Promise.all([
    openLiabilityReport(),
    pool.query<{ action: string; at: Date }>(
      `SELECT action, MAX(at) AS at FROM audit_log
        WHERE action IN ('reconcile.scheduled','alert.sync_lag')
        GROUP BY action`,
    ),
  ]);
  const at = (action: string) => lastRuns.rows.find((r) => r.action === action)?.at ?? null;
  res.json({
    scheduler: {
      reconcileIntervalMinutes: policy.reconcileIntervalMinutes,
      pruneIntervalHours: policy.pruneIntervalHours,
      pollIntervalMinutes: policy.pollIntervalMinutes,
      alertScanMinutes: policy.alertScanMinutes,
    },
    syncLag: summarizeSyncLag(await syncLagReport()),
    liability: {
      unconfirmedWrites: liability.unconfirmed_writes.length,
      unresolvedAlerts: liability.unresolved_alerts.length,
      pendingReviews: liability.aging_reviews.length,
    },
    lastRuns: {
      reconcile: at('reconcile.scheduled'),
      alertScan: at('alert.sync_lag'),
    },
    readiness: computeReadiness({
      nodeEnvProduction: isProd(),
      enableOutboundWrites: policy.enableOutboundWrites,
      appSecretStrong: ((): boolean => {
        const s = readSecret('APP_SECRET');
        return !!s && s !== DEV_APP_SECRET && s.length >= 16;
      })(),
      trustProxySet: !!trustProxy,
      forceHttps,
      webhookPublicBaseSet: !!process.env.WEBHOOK_PUBLIC_BASE,
      reconcileIntervalMinutes: policy.reconcileIntervalMinutes,
      alertScanMinutes: policy.alertScanMinutes,
    }),
  });
});

// Split-retention prune of the consent-check audit table (ADR-0004 §7).
// Destructive maintenance → admin only. On-demand like the reconciler; a
// production deployment schedules this (cron/job runner).
app.post('/api/consent-checks/prune', requireRole('admin'), async (req, res) => {
  res.json(await pruneConsentChecks(req.user!.username));
});

// Operational audit_log retention prune (DESIGN.md §14). Prunes rows past the
// window (default 14 days) EXCEPT compliance-relevant actions, which are kept.
// Destructive maintenance → admin only; also runs on the scheduler.
app.post('/api/audit-log/prune', requireRole('admin'), async (req, res) => {
  res.json(await pruneAuditLog(req.user!.username));
});

app.get('/api/audit', requireRole('viewer'), async (_req, res) => {
  const r = await pool.query(
    `SELECT a.*, u.username AS actor_username, ${AUDIT_ACTOR_LABEL} AS actor_label
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
      ORDER BY a.id DESC LIMIT 100`,
  );
  res.json(r.rows);
});

app.get('/api/alerts', requireRole('viewer'), async (_req, res) => {
  const r = await pool.query(
    `SELECT ra.*, i.value_normalized FROM reconcile_alerts ra
      JOIN identities i ON i.id = ra.identity_id
      WHERE ra.resolved_at IS NULL ORDER BY ra.id DESC`,
  );
  res.json(r.rows);
});

// ---- Service-discovered topology (ADR-0002) ---------------------------------
// Reporting/attribution metadata only — never a consent-scope authority.
// viewer: read · operator: trigger sync, manage manual annotations.

app.get('/api/topology', requireRole('viewer'), async (req, res) => {
  const systemId = String(req.query.system ?? '').trim();
  if (!systemId) {
    res.status(400).json({ error: 'system query parameter required' });
    return;
  }
  try {
    res.json(await getTopology(systemId));
  } catch (e: any) {
    res.status(404).json({ error: e.message });
  }
});

app.post('/api/topology/sync', requireRole('operator'), async (req, res) => {
  try {
    const systemId = (req.body?.system as string)?.trim();
    const actor = req.user!.username;
    res.json(systemId
      ? { results: [await syncTopology(systemId, actor)] }
      : { results: await syncAllTopology(actor) });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/topology/annotate', requireRole('operator'), async (req, res) => {
  try {
    const { system, code_ref, label } = req.body ?? {};
    if (!system || !code_ref) {
      res.status(400).json({ error: 'system and code_ref required' });
      return;
    }
    const ann = await annotateCode(
      String(system), String(code_ref), String(label ?? ''),
      req.user!.username, req.user!.id,
    );
    res.json(ann);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/topology/annotate', requireRole('operator'), async (req, res) => {
  const { system, code_ref } = req.body ?? {};
  if (!system || !code_ref) {
    res.status(400).json({ error: 'system and code_ref required' });
    return;
  }
  const removed = await removeAnnotation(String(system), String(code_ref), req.user!.username);
  res.json({ removed });
});

// ---- Reporting module (read-only; viewer role) ------------------------------
// Identity lookup + full history, user-action audit search, and the law-driven
// reports (sync-lag §8.4, open-liability §2.4, activity §14).

const parseDate = (v: unknown): Date | null => {
  if (!v) return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

// Search by phone or email → current state + full history + approvals + alerts.
app.get('/api/reports/identity', requireRole('viewer'), async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) {
    res.status(400).json({ error: 'q (phone or email) required' });
    return;
  }
  const packet = await lookupIdentity(q);
  if (!packet) {
    res.status(404).json({ error: 'no identity matches that phone/email' });
    return;
  }
  res.json(packet);
});

// Downloadable §227(c)(5) discovery packet, as JSON or CSV (event history).
app.get('/api/reports/identity/:id/packet', requireRole('viewer'), async (req, res) => {
  const r = await pool.query('SELECT value_normalized FROM identities WHERE id=$1', [
    Number(req.params.id),
  ]);
  if (!r.rows[0]) {
    res.status(404).json({ error: 'unknown identity' });
    return;
  }
  const packet = await lookupIdentity(r.rows[0].value_normalized);
  if (!packet) {
    res.status(404).json({ error: 'unknown identity' });
    return;
  }
  const slug = packet.identity.value_normalized.replace(/[^a-zA-Z0-9]+/g, '_');
  const stamped = { ...packet, generated_at: new Date().toISOString() };
  if (req.query.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="consent_${slug}.csv"`);
    res.send(packetToCsv(packet));
    return;
  }
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="consent_${slug}.json"`);
  res.send(JSON.stringify(stamped, null, 2));
});

// Audit / user-action search for accountability tracking.
app.get('/api/reports/audit', requireRole('viewer'), async (req, res) => {
  const rows = await searchAudit({
    actor: (req.query.actor as string) || null,
    action: (req.query.action as string) || null,
    from: parseDate(req.query.from),
    to: parseDate(req.query.to),
    limit: req.query.limit ? Number(req.query.limit) : undefined,
  });
  res.json(rows);
});

app.get('/api/reports/audit/facets', requireRole('viewer'), async (_req, res) => {
  res.json(await auditFacets());
});

// Opt-out sync-lag: convergence timing vs the 10-business-day ceiling.
app.get('/api/reports/sync-lag', requireRole('viewer'), async (req, res) => {
  res.json(await syncLagReport({ from: parseDate(req.query.from), to: parseDate(req.query.to) }));
});

// Open liability: current under-suppression risk surface.
app.get('/api/reports/liability', requireRole('viewer'), async (_req, res) => {
  res.json(await openLiabilityReport());
});

// Activity / volume summary by system, channel, direction, provenance.
app.get('/api/reports/activity', requireRole('viewer'), async (req, res) => {
  res.json(await activitySummary({ from: parseDate(req.query.from), to: parseDate(req.query.to) }));
});

// Topology attribution: event volume by receiving code → department/pool
// (ADR-0002 §4). Reporting only; shows discovered grouping and manual
// annotation side by side.
app.get('/api/reports/topology', requireRole('viewer'), async (req, res) => {
  res.json(await topologyAttributionReport({ from: parseDate(req.query.from), to: parseDate(req.query.to) }));
});

// Express 5 forwards async handler rejections here — no silent crashes.
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) return next(err);
  log.error('unhandled_route_error', { reqId: req.id, path: req.path, error: err.message });
  res.status(500).json({ error: 'internal server error' }); // don't leak internals
});

const port = Number(process.env.PORT ?? 3000);

/**
 * Hydrate caches, bind the port, and start background jobs. Split out from module
 * scope so integration tests can `import { app }` and drive routes against an
 * ephemeral listener WITHOUT the real port bind, scheduler, or Redis wiring.
 * Production/dev (`tsx src/api/server.ts`) still runs the identical sequence.
 */
export async function startServer(): Promise<import('node:http').Server> {
  await loadAdapters();
  await hydratePolicy(); // overlay DB config before the scheduler reads intervals
  await hydrateCategories(); // load the category cascade matrix into the live cache

  // Loud, once-per-boot reminder when the outbound-write kill switch is engaged —
  // the hub ingests but pushes nothing to sending services (test mode).
  if (!policy.enableOutboundWrites) {
    log.warn('outbound_writes_disabled', {
      detail: 'TEST MODE — outbound opt-out/opt-in writes to sending services are DISABLED ' +
        '(enableOutboundWrites=off). The hub ingests and records events but pushes nothing to platforms. ' +
        'Set ENABLE_OUTBOUND_WRITES=true (or toggle Settings → Safety) for production.',
    });
  }

  const server = app.listen(port, () => log.info('server_listening', { port }));
  server.on('error', (e: any) => {
    if (e?.code === 'EADDRINUSE') {
      // A stale server (often an orphaned `tsx`/node child) is holding the port;
      // the new process can't bind. Fail loudly with the fix rather than draining
      // the loop and looking like a silent crash.
      diag(`\n[fatal] Port ${port} is already in use — another instance is still running.\n` +
           `        Stop it, then restart. Windows: taskkill /IM node.exe /F  ·  ` +
           `macOS/Linux: lsof -ti:${port} | xargs kill\n`);
      log.error('port_in_use', { port });
    } else {
      diag(`[server error] ${e?.stack ?? e?.message ?? e}`);
      log.error('server_error', { error: e?.message ?? String(e) });
    }
    process.exit(1);
  });

  // Background maintenance jobs (reconciliation + consent-check audit prune).
  // Intervals come from config (DB, env-seeded); no-op unless set.
  startScheduler();

  // Shared rate-limit store for multi-instance (opt-in). Without REDIS_URL the
  // in-memory per-process store stays in use; on init failure we log and keep it.
  if (process.env.REDIS_URL) {
    createRedisRateLimitStore(process.env.REDIS_URL)
      .then((store) => { setRateLimitStore(store); log.info('ratelimit_redis_active'); })
      .catch((e) => log.error('ratelimit_redis_init_failed', { error: e.message }));
  }
  return server;
}

// Start on import EXCEPT when a test harness sets HUB_NO_LISTEN=1 (it imports
// `app` and binds its own ephemeral port). Top-level await keeps the entry
// module "running" through startup so the http.Server handle holds the loop.
if (process.env.HUB_NO_LISTEN !== '1') {
  await startServer();
}
