import { pool } from '../db.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { revokeUserSessions } from './sessions.js';

export type Role = 'viewer' | 'operator' | 'approver' | 'admin';
export const ROLE_RANK: Record<Role, number> = { viewer: 1, operator: 2, approver: 3, admin: 4 };

export function hasRole(userRole: Role, required: Role): boolean {
  return ROLE_RANK[userRole] >= ROLE_RANK[required];
}

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

export async function audit(
  actorUserId: number | null,
  actorName: string | null,
  action: string,
  detail: unknown,
): Promise<void> {
  await pool.query(
    'INSERT INTO audit_log (actor, action, detail, actor_user_id) VALUES ($1,$2,$3,$4)',
    [actorName, action, JSON.stringify(detail), actorUserId],
  );
}

export async function localLogin(
  username: string,
  password: string,
): Promise<{ ok: true; userId: number } | { ok: false; reason: string }> {
  const r = await pool.query(
    `SELECT u.id, u.status, lc.password_hash, lc.failed_count, lc.locked_until
       FROM users u JOIN local_credentials lc ON lc.user_id = u.id
      WHERE u.username = $1`,
    [username],
  );
  const row = r.rows[0];

  // Always burn a verification even for unknown users (timing uniformity).
  if (!row) {
    await verifyPassword(password, 'scrypt$131072$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    await audit(null, username, 'login_failed', { username, reason: 'unknown user or no local credential' });
    return { ok: false, reason: 'invalid username or password' };
  }
  if (row.status !== 'active') {
    await audit(null, username, 'login_failed', { username, reason: 'account disabled' });
    return { ok: false, reason: 'account is disabled' };
  }
  if (row.locked_until && new Date(row.locked_until) > new Date()) {
    await audit(row.id, username, 'login_failed', { username, reason: 'locked' });
    return { ok: false, reason: 'account temporarily locked after repeated failures — try again later' };
  }

  const valid = await verifyPassword(password, row.password_hash);
  if (!valid) {
    const failed = row.failed_count + 1;
    await pool.query(
      `UPDATE local_credentials
          SET failed_count=$2::int,
              locked_until = CASE WHEN $2::int >= $3::int THEN now() + interval '${LOCK_MINUTES} minutes' END
        WHERE user_id=$1`,
      [row.id, failed, MAX_FAILED],
    );
    await audit(row.id, username, 'login_failed', { username, failed_count: failed });
    return { ok: false, reason: 'invalid username or password' };
  }

  await pool.query(
    'UPDATE local_credentials SET failed_count=0, locked_until=NULL WHERE user_id=$1',
    [row.id],
  );
  await audit(row.id, username, 'login_success', { username, method: 'local' });
  return { ok: true, userId: row.id };
}

export interface CreateUserInput {
  username: string;
  display_name: string;
  email?: string;
  role: Role;
  password?: string; // omit for SSO-only users
}

export async function createUser(
  input: CreateUserInput,
  createdBy: { id: number | null; name: string },
): Promise<number> {
  const u = await pool.query(
    `INSERT INTO users (username, display_name, email, role)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [input.username, input.display_name, input.email ?? null, input.role],
  );
  const userId: number = u.rows[0].id;
  if (input.password) {
    const hash = await hashPassword(input.password);
    await pool.query(
      'INSERT INTO local_credentials (user_id, password_hash) VALUES ($1,$2)',
      [userId, hash],
    );
  }
  await audit(createdBy.id, createdBy.name, 'user_created', {
    user_id: userId,
    username: input.username,
    role: input.role,
    has_local_credential: Boolean(input.password),
  });
  return userId;
}

export async function setRole(
  userId: number,
  role: Role,
  by: { id: number; name: string },
): Promise<void> {
  await pool.query('UPDATE users SET role=$2 WHERE id=$1', [userId, role]);
  await revokeUserSessions(userId); // role changes take effect immediately
  await audit(by.id, by.name, 'role_changed', { user_id: userId, new_role: role });
}

export async function setStatus(
  userId: number,
  status: 'active' | 'disabled',
  by: { id: number; name: string },
): Promise<void> {
  await pool.query('UPDATE users SET status=$2 WHERE id=$1', [userId, status]);
  if (status === 'disabled') await revokeUserSessions(userId);
  await audit(by.id, by.name, 'user_status_changed', { user_id: userId, status });
}

export async function resetPassword(
  userId: number,
  password: string,
  by: { id: number; name: string },
): Promise<void> {
  const hash = await hashPassword(password);
  await pool.query(
    `INSERT INTO local_credentials (user_id, password_hash, updated_at, failed_count, locked_until)
     VALUES ($1,$2,now(),0,NULL)
     ON CONFLICT (user_id) DO UPDATE SET password_hash=$2, updated_at=now(), failed_count=0, locked_until=NULL`,
    [userId, hash],
  );
  await revokeUserSessions(userId);
  await audit(by.id, by.name, 'password_reset', { user_id: userId });
}

export async function listUsers(): Promise<unknown[]> {
  const r = await pool.query(
    `SELECT u.id, u.username, u.display_name, u.email, u.role, u.status, u.created_at,
            (lc.user_id IS NOT NULL) AS has_local_credential,
            COALESCE(json_agg(json_build_object('provider', sl.provider, 'issuer', sl.issuer,
              'last_login_at', sl.last_login_at)) FILTER (WHERE sl.id IS NOT NULL), '[]') AS sso_links
       FROM users u
       LEFT JOIN local_credentials lc ON lc.user_id = u.id
       LEFT JOIN sso_links sl ON sl.user_id = u.id
      GROUP BY u.id, lc.user_id ORDER BY u.id`,
  );
  return r.rows;
}
