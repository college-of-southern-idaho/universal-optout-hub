import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { requireSecret } from './config.js';

/**
 * Symmetric encryption for stored service credentials (migration 005).
 *
 * Credentials must be usable at send time — a production adapter calls the
 * platform API with them — so unlike passwords they are reversibly encrypted
 * rather than one-way hashed. AES-256-GCM with a key derived from APP_SECRET
 * via scrypt: Node's built-in crypto, no native addon, the same posture as the
 * scrypt password hashing in auth/passwords.ts.
 *
 * APP_SECRET is resolved through config.readSecret, so it can come from a
 * mounted file (`APP_SECRET_FILE`) rather than the environment. In production a
 * missing/weak/dev-default key makes the process refuse to boot — otherwise a
 * forgotten APP_SECRET would silently encrypt every credential under a key
 * that's public in this source (PRODUCTION-READINESS §1).
 *
 * The stored blob is base64(iv[12] | authTag[16] | ciphertext). Secrets are
 * never logged and never returned through the API (see services/systems.ts);
 * the API exposes only the metadata helpers below.
 */

export const DEV_APP_SECRET = 'dev-insecure-app-secret-change-me';

const APP_SECRET = requireSecret('APP_SECRET', {
  minLength: 16,
  devFallback: DEV_APP_SECRET,
  forbid: [DEV_APP_SECRET],
});

/**
 * Derive the AES-256 data-encryption key from a secret. Fixed salt is fine
 * here: the salt binds the KDF to this purpose, not to a per-record value
 * (GCM's random IV gives per-record uniqueness). Exported so the rotation tool
 * can derive the old and new keys.
 */
export function deriveKey(secret: string): Buffer {
  return scryptSync(secret, 'optout-hub/credentials/v1', 32);
}

// The active key, derived from APP_SECRET.
const KEY = deriveKey(APP_SECRET);

const IV_LEN = 12;
const TAG_LEN = 16;

/** Encrypt with an explicit key (used by the rotation tool). */
export function encryptSecretWith(key: Buffer, plaintext: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

/** Decrypt with an explicit key (used by the rotation tool). */
export function decryptSecretWith(key: Buffer, blob: string): string {
  const buf = Buffer.from(blob, 'base64');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

export function encryptSecret(plaintext: string): string {
  return encryptSecretWith(KEY, plaintext);
}

export function decryptSecret(blob: string): string {
  return decryptSecretWith(KEY, blob);
}

/** Non-sensitive display hint: the last 4 chars, masked entirely if too short. */
export function last4(secret: string): string {
  const s = secret.trim();
  return s.length <= 4 ? '*'.repeat(s.length) : s.slice(-4);
}
