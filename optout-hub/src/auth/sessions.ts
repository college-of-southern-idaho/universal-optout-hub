import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { pool } from '../db.js';

export const SESSION_COOKIE = 'hub_session';
const SESSION_HOURS = 12;
const SLIDE_THRESHOLD_HOURS = 1;

export interface SessionUser {
  id: number;
  username: string;
  display_name: string;
  role: 'viewer' | 'operator' | 'approver' | 'admin';
  status: string;
}

/** A resolved session: the user plus the session's CSRF token. */
export interface ResolvedSession {
  user: SessionUser;
  csrfToken: string;
}

export async function createSession(req: Request, res: Response, userId: number): Promise<void> {
  const token = randomBytes(32).toString('hex');
  const csrf = randomBytes(32).toString('hex');
  await pool.query(
    `INSERT INTO sessions (token, user_id, expires_at, ip, user_agent, csrf_token)
     VALUES ($1,$2, now() + interval '${SESSION_HOURS} hours', $3, $4, $5)`,
    [token, userId, req.ip ?? null, req.headers['user-agent'] ?? null, csrf],
  );
  setSessionCookie(res, token, SESSION_HOURS * 3600);
}

export async function destroySession(req: Request, res: Response): Promise<void> {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) await pool.query('DELETE FROM sessions WHERE token=$1', [token]);
  setSessionCookie(res, '', 0);
}

/** Revoke every session for a user — role changes and disables bite immediately. */
export async function revokeUserSessions(userId: number): Promise<void> {
  await pool.query('DELETE FROM sessions WHERE user_id=$1', [userId]);
}

export async function resolveSession(req: Request): Promise<ResolvedSession | null> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const r = await pool.query(
    `SELECT s.token, s.expires_at, s.csrf_token, u.id, u.username, u.display_name, u.role, u.status
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token=$1 AND s.expires_at > now()`,
    [token],
  );
  const row = r.rows[0];
  if (!row || row.status !== 'active') return null;

  // Sliding expiry: refresh when within the slide window of expiring.
  const remainingMs = new Date(row.expires_at).getTime() - Date.now();
  if (remainingMs < (SESSION_HOURS - SLIDE_THRESHOLD_HOURS) * 3600_000) {
    await pool.query(
      `UPDATE sessions SET expires_at = now() + interval '${SESSION_HOURS} hours' WHERE token=$1`,
      [token],
    );
  }

  // Lazy backfill: sessions created before migration 013 have no CSRF token.
  let csrfToken: string = row.csrf_token;
  if (!csrfToken) {
    csrfToken = randomBytes(32).toString('hex');
    await pool.query('UPDATE sessions SET csrf_token=$1 WHERE token=$2', [csrfToken, token]);
  }

  return {
    user: {
      id: row.id,
      username: row.username,
      display_name: row.display_name,
      role: row.role,
      status: row.status,
    },
    csrfToken,
  };
}

// --- minimal cookie helpers (avoids a dependency) --------------------------

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function setSessionCookie(res: Response, value: string, maxAgeSeconds: number): void {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.append(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(value)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`,
  );
}
