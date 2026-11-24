import { randomBytes } from 'node:crypto';
import type { Request, Response, Express } from 'express';
import { pool } from '../db.js';
import { audit, type Role, ROLE_RANK } from './users.js';
import { createSession } from './sessions.js';
import { readSecret } from '../core/config.js';

/**
 * SSO design (per the auth discussion):
 *  - Protocol-agnostic core: every protocol reduces to (issuer, subject) →
 *    user, via `completeSsoLogin`. OIDC is implemented; a SAML strategy can
 *    reuse the same completion path and sso_links schema.
 *  - JIT provisioning into the configured default role (viewer unless
 *    overridden) — SSO membership alone never grants the power to attest.
 *  - Optional group→role mapping (OIDC_ROLE_MAP) syncs role on each login;
 *    when unset, roles are managed manually by an admin.
 *
 * Configuration (environment):
 *  OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_REDIRECT_URI
 *  OIDC_PROVIDER_NAME   display name + sso_links.provider key (default 'oidc')
 *  OIDC_ROLE_CLAIM      claim containing groups/roles (default 'groups')
 *  OIDC_ROLE_MAP        JSON, e.g. {"sg-optout-approvers":"approver"}
 *  SSO_JIT_ROLE         default role for first-time SSO users (default 'viewer')
 *  AUTH_DEV_MOCK_SSO=1  enable the built-in mock IdP (non-production only)
 */

const JIT_ROLE = (process.env.SSO_JIT_ROLE as Role) ?? 'viewer';

function mapGroupsToRole(groups: string[]): Role | null {
  const raw = process.env.OIDC_ROLE_MAP;
  if (!raw) return null;
  let map: Record<string, Role>;
  try {
    map = JSON.parse(raw);
  } catch {
    return null;
  }
  let best: Role | null = null;
  for (const g of groups) {
    const r = map[g];
    if (r && (!best || ROLE_RANK[r] > ROLE_RANK[best])) best = r;
  }
  return best;
}

export interface SsoProfile {
  issuer: string;
  subject: string;
  provider: string;
  display_name: string;
  email?: string;
  groups: string[];
}

/** Shared completion path for every SSO protocol. Returns the user id. */
export async function completeSsoLogin(p: SsoProfile): Promise<number> {
  const linked = await pool.query(
    'SELECT user_id FROM sso_links WHERE issuer=$1 AND subject=$2',
    [p.issuer, p.subject],
  );

  let userId: number;
  if (linked.rows[0]) {
    userId = linked.rows[0].user_id;
    await pool.query('UPDATE sso_links SET last_login_at=now() WHERE issuer=$1 AND subject=$2', [
      p.issuer,
      p.subject,
    ]);
  } else {
    // JIT provisioning. Username: prefer email, else provider:subject.
    const username = (p.email ?? `${p.provider}:${p.subject}`).toLowerCase();
    const existing = await pool.query('SELECT id FROM users WHERE username=$1', [username]);
    if (existing.rows[0]) {
      // Same human, new link (e.g. local account later bound to SSO).
      userId = existing.rows[0].id;
    } else {
      const ins = await pool.query(
        `INSERT INTO users (username, display_name, email, role) VALUES ($1,$2,$3,$4) RETURNING id`,
        [username, p.display_name || username, p.email ?? null, JIT_ROLE],
      );
      userId = ins.rows[0].id;
      await audit(userId, username, 'user_created', {
        user_id: userId,
        via: 'sso_jit',
        provider: p.provider,
        role: JIT_ROLE,
      });
    }
    await pool.query(
      `INSERT INTO sso_links (user_id, provider, issuer, subject, last_login_at)
       VALUES ($1,$2,$3,$4,now())`,
      [userId, p.provider, p.issuer, p.subject],
    );
  }

  // Optional role sync from IdP groups.
  const mapped = mapGroupsToRole(p.groups);
  if (mapped) {
    await pool.query(`UPDATE users SET role=$2 WHERE id=$1 AND role <> $2 AND status='active'`, [
      userId,
      mapped,
    ]);
  }

  const u = await pool.query('SELECT username, status FROM users WHERE id=$1', [userId]);
  if (u.rows[0]?.status !== 'active') throw new Error('account is disabled');
  await audit(userId, u.rows[0].username, 'login_success', {
    method: 'sso',
    provider: p.provider,
    issuer: p.issuer,
  });
  return userId;
}

export function ssoProvidersEnabled(): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  if (process.env.OIDC_ISSUER && process.env.OIDC_CLIENT_ID) {
    out.push({
      id: 'oidc',
      name: process.env.OIDC_PROVIDER_NAME ?? 'Single sign-on',
    });
  }
  if (process.env.AUTH_DEV_MOCK_SSO === '1' && process.env.NODE_ENV !== 'production') {
    out.push({ id: 'dev', name: 'Dev mock SSO (testing only)' });
  }
  return out;
}

// --- OIDC (authorization code + PKCE) --------------------------------------

export function registerSsoRoutes(app: Express): void {
  if (process.env.OIDC_ISSUER && process.env.OIDC_CLIENT_ID) {
    registerOidcRoutes(app);
  }
  if (process.env.AUTH_DEV_MOCK_SSO === '1' && process.env.NODE_ENV !== 'production') {
    registerDevMockRoutes(app);
  }
}

function registerOidcRoutes(app: Express): void {
  // Lazy import so the dependency is only loaded when OIDC is configured.
  let clientPromise: Promise<any> | null = null;
  async function getClient(): Promise<any> {
    if (!clientPromise) {
      clientPromise = (async () => {
        const { Issuer } = await import('openid-client');
        const issuer = await Issuer.discover(process.env.OIDC_ISSUER!);
        return new issuer.Client({
          client_id: process.env.OIDC_CLIENT_ID!,
          client_secret: readSecret('OIDC_CLIENT_SECRET'),
          redirect_uris: [process.env.OIDC_REDIRECT_URI!],
          response_types: ['code'],
        });
      })();
    }
    return clientPromise;
  }

  app.get('/auth/sso/oidc/start', async (_req: Request, res: Response) => {
    try {
      const { generators } = await import('openid-client');
      const client = await getClient();
      const code_verifier = generators.codeVerifier();
      const code_challenge = generators.codeChallenge(code_verifier);
      const state = randomBytes(16).toString('hex');
      await pool.query(
        `INSERT INTO sso_login_states (state, provider, code_verifier) VALUES ($1,'oidc',$2)`,
        [state, code_verifier],
      );
      res.redirect(
        client.authorizationUrl({
          scope: 'openid profile email',
          code_challenge,
          code_challenge_method: 'S256',
          state,
        }),
      );
    } catch (e: any) {
      res.status(500).send(`OIDC start failed: ${e.message}`);
    }
  });

  app.get('/auth/sso/oidc/callback', async (req: Request, res: Response) => {
    try {
      const client = await getClient();
      const params = client.callbackParams(req);
      const st = await pool.query(
        `DELETE FROM sso_login_states WHERE state=$1 AND provider='oidc'
           AND created_at > now() - interval '10 minutes' RETURNING code_verifier`,
        [params.state],
      );
      if (!st.rows[0]) throw new Error('login state expired or unknown — start over');
      const tokenSet = await client.callback(process.env.OIDC_REDIRECT_URI!, params, {
        code_verifier: st.rows[0].code_verifier,
        state: params.state,
      });
      const claims = tokenSet.claims();
      const roleClaim = process.env.OIDC_ROLE_CLAIM ?? 'groups';
      const groups: string[] = Array.isArray((claims as any)[roleClaim])
        ? (claims as any)[roleClaim]
        : [];
      const userId = await completeSsoLogin({
        issuer: claims.iss,
        subject: claims.sub,
        provider: process.env.OIDC_PROVIDER_NAME ?? 'oidc',
        display_name: (claims.name as string) ?? (claims.preferred_username as string) ?? claims.sub,
        email: claims.email as string | undefined,
        groups,
      });
      await createSession(req, res, userId);
      res.redirect('/');
    } catch (e: any) {
      res.status(401).send(`SSO sign-in failed: ${e.message}`);
    }
  });
}

// --- Dev mock IdP (testing the JIT/link/role-mapping path without an IdP) --

function registerDevMockRoutes(app: Express): void {
  const ISSUER = 'https://dev-mock-idp.local';

  app.get('/auth/sso/dev/start', (_req: Request, res: Response) => {
    res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:480px;margin:60px auto">
      <h2>Dev mock identity provider</h2>
      <p>Simulates an SSO assertion. <strong>Testing only</strong> — disabled in production.</p>
      <form method="POST" action="/auth/sso/dev/complete">
        <label>Subject (stable user id at the IdP)<br><input name="subject" value="user-001" style="width:100%"></label><br><br>
        <label>Display name<br><input name="name" value="Dev SSO User" style="width:100%"></label><br><br>
        <label>Email<br><input name="email" value="dev.sso@example.edu" style="width:100%"></label><br><br>
        <label>Groups (comma-separated)<br><input name="groups" value="" style="width:100%"></label><br><br>
        <button type="submit">Sign in</button>
      </form></body></html>`);
  });

  app.post(
    '/auth/sso/dev/complete',
    // body parsed by express.urlencoded registered in server.ts
    async (req: Request, res: Response) => {
      try {
        const userId = await completeSsoLogin({
          issuer: ISSUER,
          subject: String(req.body.subject ?? 'user-001'),
          provider: 'dev',
          display_name: String(req.body.name ?? 'Dev SSO User'),
          email: req.body.email ? String(req.body.email) : undefined,
          groups: String(req.body.groups ?? '')
            .split(',')
            .map((s: string) => s.trim())
            .filter(Boolean),
        });
        await createSession(req, res, userId);
        res.redirect('/');
      } catch (e: any) {
        res.status(401).send(`Mock SSO failed: ${e.message}`);
      }
    },
  );
}
