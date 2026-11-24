import { timingSafeEqual, randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { resolveSession, type SessionUser } from './sessions.js';
import { hasRole, type Role } from './users.js';
import { log } from '../core/logger.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
      csrfToken?: string;
      id?: string; // per-request correlation id (set by requestLogger)
    }
  }
}

// Health/metrics endpoints are scraped continuously; log them at debug so they
// don't drown the access log at the default level.
const QUIET_PATHS = new Set(['/healthz', '/readyz', '/metrics']);

/**
 * Assign a correlation id to each request, echo it in `X-Request-Id`, and emit
 * one structured access-log line when the response finishes (method, routed
 * path, status, latency, actor, ip). Runs first so it times the whole chain;
 * `actor` is read at finish, after attachUser has populated req.user.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const id = randomUUID();
  req.id = id;
  res.setHeader('X-Request-Id', id);
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Math.round(Number(process.hrtime.bigint() - start) / 1e5) / 10;
    const level = QUIET_PATHS.has(req.path) ? 'debug' : res.statusCode >= 500 ? 'error' : 'info';
    log[level]('http_request', {
      reqId: id,
      method: req.method,
      path: req.path, // no query string → avoids logging tokens passed as params
      status: res.statusCode,
      durationMs,
      actor: req.user?.username ?? null,
      ip: req.ip,
    });
  });
  next();
}

/** Attach the session user + CSRF token (if any) to the request. Never blocks. */
export async function attachUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const session = await resolveSession(req);
    req.user = session?.user;
    req.csrfToken = session?.csrfToken;
  } catch {
    req.user = undefined;
    req.csrfToken = undefined;
  }
  next();
}

const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Constant-time string equality that tolerates unequal lengths. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Pure CSRF check. Safe methods always pass; otherwise the header token must
 * match the session's token. Exported for unit testing.
 */
export function csrfValid(method: string, sessionCsrf: string | undefined, headerToken: string | undefined): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return true;
  if (!sessionCsrf || !headerToken) return false;
  return safeEqual(sessionCsrf, headerToken);
}

/**
 * CSRF guard for the cookie-authenticated console (synchronizer-token pattern,
 * defense-in-depth on top of the SameSite=Lax session cookie). Only enforced
 * when the request rides a SESSION cookie (`req.user` set): machine callers
 * (API-key consent-check) and platform webhooks (signature-verified) carry no
 * session, so they're naturally exempt — the risk CSRF addresses is the ambient
 * cookie credential, which those don't use. Must run after `attachUser`.
 */
export function requireCsrf(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) { next(); return; } // not a cookie-session request → not a CSRF vector
  if (csrfValid(req.method, req.csrfToken, req.header(CSRF_HEADER))) { next(); return; }
  res.status(403).json({ error: 'invalid or missing CSRF token' });
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'authentication required' });
    return;
  }
  next();
}

/** Role hierarchy: viewer < operator < approver < admin. */
export function requireRole(role: Role) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'authentication required' });
      return;
    }
    if (!hasRole(req.user.role, role)) {
      res.status(403).json({ error: `requires ${role} role (you are ${req.user.role})` });
      return;
    }
    next();
  };
}
