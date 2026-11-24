import { pool } from '../db.js';
import { decryptSecret, encryptSecret, last4 } from '../core/secrets.js';

/**
 * Server-only: decrypt a system's stored credentials for use by a real adapter
 * at send/discovery time. NOT exposed through any HTTP route — the API never
 * returns plaintext secrets. Lives in its own module so both the adapter
 * registry and the systems service can use it without an import cycle.
 */
export async function getDecryptedCredentials(systemId: string): Promise<Record<string, string>> {
  const r = await pool.query<{ cred_key: string; secret_enc: string }>(
    'SELECT cred_key, secret_enc FROM system_credentials WHERE system_id=$1', [systemId],
  );
  const out: Record<string, string> = {};
  for (const row of r.rows) out[row.cred_key] = decryptSecret(row.secret_enc);
  return out;
}

/**
 * Server-only: persist a machine-rotated credential (e.g. an OAuth access or
 * refresh token the hub refreshed unattended). Encrypts at rest like any other
 * credential and records an optional expiry. `updated_by` is a marker, not a
 * user. Used by live adapters that rotate tokens; never exposed via HTTP.
 */
export async function storeRotatedCredential(
  systemId: string,
  key: string,
  value: string,
  expiresAt: Date | null = null,
): Promise<void> {
  await pool.query(
    `INSERT INTO system_credentials (system_id, cred_key, secret_enc, last4, expires_at, updated_at, updated_by)
       VALUES ($1,$2,$3,$4,$5,now(),'system:oauth-refresh')
     ON CONFLICT (system_id, cred_key)
     DO UPDATE SET secret_enc=$3, last4=$4, expires_at=$5, updated_at=now(), updated_by='system:oauth-refresh'`,
    [systemId, key, encryptSecret(value), last4(value), expiresAt],
  );
}
