import { randomBytes, createHash } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { pool } from '../db.js';

/**
 * Service API keys for the consent-check API (ADR-0004 §2.3, Class B).
 *
 * Machine callers (a sending service), so this is a separate auth surface from
 * the session/OIDC path used by humans (DESIGN §12). A key is bound to one
 * system, shown once at creation, and stored only as a sha256 hash. API keys
 * are high-entropy random tokens, so a fast hash is appropriate here — unlike
 * user passwords, which use scrypt (auth/passwords.ts). Revocation is immediate:
 * every request re-checks revoked_at.
 */

const PREFIX = 'oohk_'; // opt-out-hub key — recognizable, greppable in leaks

export interface ApiKeyIdentity {
  id: number;
  system_id: string;
  /** Per-key requests/sec override; null → use the hub-wide default (ADR-0004 §8). */
  rate_limit_per_sec: number | null;
}

export interface ApiKeyMeta {
  id: number;
  label: string;
  key_prefix: string;
  created_by: string;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
  rate_limit_per_sec: number | null;
}

export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

/** A fresh key: the plaintext is returned to the caller exactly once. */
export function generateApiKey(): { plaintext: string; hash: string; prefix: string } {
  const plaintext = PREFIX + randomBytes(24).toString('base64url'); // ~32 random chars
  return { plaintext, hash: hashApiKey(plaintext), prefix: plaintext.slice(0, 13) };
}

export async function createApiKey(
  systemId: string,
  label: string,
  createdBy: string,
  rateLimitPerSec: number | null = null,
): Promise<{ id: number; plaintext: string; prefix: string }> {
  const { plaintext, hash, prefix } = generateApiKey();
  const r = await pool.query<{ id: number }>(
    `INSERT INTO service_api_keys (system_id, label, key_hash, key_prefix, created_by, rate_limit_per_sec)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [systemId, label, hash, prefix, createdBy, rateLimitPerSec],
  );
  const id = r.rows[0].id;
  await pool.query(
    `INSERT INTO audit_log (actor, action, detail) VALUES ($1,'api_key.create',$2)`,
    [createdBy, { system_id: systemId, key_id: id, label, rate_limit_per_sec: rateLimitPerSec }],
  );
  return { id, plaintext, prefix };
}

export async function listApiKeys(systemId: string): Promise<ApiKeyMeta[]> {
  const r = await pool.query<ApiKeyMeta>(
    `SELECT id, label, key_prefix, created_by, created_at, last_used_at, revoked_at, rate_limit_per_sec
       FROM service_api_keys WHERE system_id=$1 ORDER BY created_at DESC`,
    [systemId],
  );
  return r.rows;
}

/** Revoke a key (scoped to its system so an admin can't revoke across systems by id guessing). Returns false if not found. */
export async function revokeApiKey(systemId: string, id: number, by: string): Promise<boolean> {
  const r = await pool.query(
    `UPDATE service_api_keys SET revoked_at=now()
       WHERE id=$1 AND system_id=$2 AND revoked_at IS NULL`,
    [id, systemId],
  );
  const ok = (r.rowCount ?? 0) > 0;
  if (ok) {
    await pool.query(
      `INSERT INTO audit_log (actor, action, detail) VALUES ($1,'api_key.revoke',$2)`,
      [by, { system_id: systemId, key_id: id }],
    );
  }
  return ok;
}

/** Verify a presented key. Returns its identity (id + system) or null. Touches last_used_at. */
export async function verifyApiKey(presented: string): Promise<ApiKeyIdentity | null> {
  if (!presented || !presented.startsWith(PREFIX)) return null;
  const r = await pool.query<ApiKeyIdentity>(
    `UPDATE service_api_keys SET last_used_at=now()
       WHERE key_hash=$1 AND revoked_at IS NULL
       RETURNING id, system_id, rate_limit_per_sec`,
    [hashApiKey(presented)],
  );
  return r.rows[0] ?? null;
}

/** Pull the key from Authorization: Bearer <key> or the X-API-Key header. */
export function extractApiKey(req: Request): string | null {
  const auth = req.header('authorization');
  if (auth && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
  const x = req.header('x-api-key');
  return x ? x.trim() : null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      apiKey?: ApiKeyIdentity;
    }
  }
}

/** Middleware: require a valid service API key; attaches req.apiKey. */
export async function requireApiKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  const presented = extractApiKey(req);
  if (!presented) {
    res.status(401).json({ error: 'API key required (Authorization: Bearer <key> or X-API-Key)' });
    return;
  }
  const found = await verifyApiKey(presented);
  if (!found) {
    res.status(401).json({ error: 'invalid or revoked API key' });
    return;
  }
  req.apiKey = found;
  next();
}
