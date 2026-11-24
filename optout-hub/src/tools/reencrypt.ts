import { pool } from '../db.js';
import { deriveKey, decryptSecretWith, encryptSecretWith } from '../core/secrets.js';
import { readSecret } from '../core/config.js';

/**
 * APP_SECRET rotation (PRODUCTION-READINESS §1). Stored service credentials are
 * encrypted under a key derived from APP_SECRET, so rotating the secret requires
 * re-encrypting every credential under the new key. This tool does that in one
 * transaction, then the old secret can be retired.
 *
 * Usage:
 *   APP_SECRET_OLD=<current>  APP_SECRET=<new>  npm run reencrypt
 *
 * (APP_SECRET / APP_SECRET_OLD may each come from a *_FILE mount too.) The tool
 * derives both keys, decrypts each secret_enc with the old key, and re-encrypts
 * with the new key. A row that already decrypts under the NEW key is skipped, so
 * the run is safe to repeat / resume after an interruption.
 */
async function main(): Promise<void> {
  const oldSecret = readSecret('APP_SECRET_OLD');
  const newSecret = readSecret('APP_SECRET');
  if (!oldSecret) throw new Error('set APP_SECRET_OLD to the current key (or APP_SECRET_OLD_FILE)');
  if (!newSecret) throw new Error('set APP_SECRET to the new key (or APP_SECRET_FILE)');
  if (oldSecret === newSecret) throw new Error('APP_SECRET and APP_SECRET_OLD are identical — nothing to rotate');

  const oldKey = deriveKey(oldSecret);
  const newKey = deriveKey(newSecret);

  const client = await pool.connect();
  let rotated = 0;
  let already = 0;
  try {
    await client.query('BEGIN');
    const rows = await client.query<{ system_id: string; cred_key: string; secret_enc: string }>(
      'SELECT system_id, cred_key, secret_enc FROM system_credentials FOR UPDATE',
    );
    for (const r of rows.rows) {
      let plaintext: string;
      try {
        plaintext = decryptSecretWith(oldKey, r.secret_enc);
      } catch {
        // Not decryptable with the old key — is it already under the new key?
        try { decryptSecretWith(newKey, r.secret_enc); already++; continue; }
        catch { throw new Error(`credential ${r.system_id}/${r.cred_key} decrypts under neither the old nor the new key`); }
      }
      const reenc = encryptSecretWith(newKey, plaintext);
      await client.query(
        'UPDATE system_credentials SET secret_enc=$1 WHERE system_id=$2 AND cred_key=$3',
        [reenc, r.system_id, r.cred_key],
      );
      rotated++;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  console.log(`re-encrypted ${rotated} credential(s); ${already} already under the new key. Retire APP_SECRET_OLD now.`);
  await pool.end();
}

main().catch((e) => { console.error('reencrypt failed:', e.message); process.exitCode = 1; });
