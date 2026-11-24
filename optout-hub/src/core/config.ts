import { readFileSync } from 'node:fs';

// Load a local `.env` into process.env if one exists, so the documented
// `cp .env.example .env` workflow actually takes effect. This module is imported
// before any secret is read, so the values are in place in time. Real
// deployments inject env vars / mounted secrets and usually have no `.env`
// (loadEnvFile throws ENOENT, which we ignore); and variables already set in the
// environment are NOT overwritten, so injected production values still win.
try {
  process.loadEnvFile();
} catch {
  /* no .env file present — use the ambient environment */
}

/**
 * Secret resolution (PRODUCTION-READINESS §1). Reads a secret from, in order:
 *
 *   1. a FILE:  `${NAME}_FILE` → the secret is the file's contents (trimmed).
 *      This is the mounted-secret pattern every orchestrator and secret manager
 *      supports — Docker secrets, Kubernetes secrets, Azure Key Vault CSI driver,
 *      HashiCorp Vault agent — so secrets never sit in `.env` or the process
 *      environment (which leaks via /proc, crash dumps, `docker inspect`).
 *   2. the ENV: `${NAME}` directly (backward compatible with the PoC).
 *
 * Provider-agnostic on purpose: no cloud SDK dependency. A deployment mounts its
 * secret manager's value as a file (or env var) and points `${NAME}_FILE` at it.
 */

export function isProd(): boolean {
  return process.env.NODE_ENV === 'production';
}

/** Resolve a secret from `${name}_FILE` (file contents) or `${name}` (env). */
export function readSecret(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const filePath = env[`${name}_FILE`];
  if (filePath) {
    try {
      const v = readFileSync(filePath, 'utf8').replace(/\r?\n$/, '');
      if (v) return v;
    } catch (e: any) {
      throw new Error(`${name}_FILE is set to "${filePath}" but could not be read: ${e.message}`);
    }
  }
  const v = env[name];
  return v && v.length ? v : undefined;
}

/**
 * Resolve a secret that is mandatory in production. In production a missing
 * secret (or one weaker than `minLength`, or equal to a known insecure default)
 * throws so the process refuses to boot. Outside production the `devFallback`
 * is used with a loud warning, so local dev stays frictionless.
 */
export function requireSecret(
  name: string,
  opts: { minLength?: number; devFallback?: string; forbid?: string[] } = {},
  env: NodeJS.ProcessEnv = process.env,
): string {
  const { minLength = 0, devFallback, forbid = [] } = opts;
  const value = readSecret(name, env);
  const prod = env.NODE_ENV === 'production';

  if (prod) {
    if (!value) throw new Error(`${name} is required in production — set ${name} or ${name}_FILE.`);
    if (forbid.includes(value)) throw new Error(`${name} must not be an insecure default value in production.`);
    if (value.length < minLength) throw new Error(`${name} must be at least ${minLength} characters in production.`);
    return value;
  }

  if (value) return value;
  if (devFallback !== undefined) {
    console.warn(`[config] ${name} not set — using an INSECURE development default. Never run production this way.`);
    return devFallback;
  }
  throw new Error(`${name} is required — set ${name} or ${name}_FILE.`);
}
