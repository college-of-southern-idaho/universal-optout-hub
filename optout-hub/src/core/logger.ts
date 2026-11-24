/**
 * Minimal structured logger. One JSON object per line to stdout
 * (info/debug) or stderr (warn/error), which any aggregator — Azure Monitor,
 * Splunk, ELK, a container platform's log pipeline — can parse without a custom
 * format. No dependency; keep it tiny.
 *
 * Config (env):
 *   LOG_LEVEL   debug | info | warn | error   (default info)
 *   LOG_FORMAT  json | pretty                  (default json; pretty for local dev)
 *
 * Never log secrets or raw PII — pass identifiers (system id, actor username,
 * normalized-value hashes) rather than message bodies or credentials.
 */

import { writeSync } from 'node:fs';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface LogFields { [key: string]: unknown }

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function envLevel(): LogLevel {
  const l = (process.env.LOG_LEVEL ?? '').toLowerCase();
  return l === 'debug' || l === 'info' || l === 'warn' || l === 'error' ? l : 'info';
}

/**
 * Pure: render a log record. JSON by default; `pretty` produces a terminal-
 * friendly line. Field order is stable (ts, level, msg, then extras) so tests
 * and human scanning are predictable.
 */
export function formatLog(
  level: LogLevel, msg: string, fields: LogFields, ts: string, pretty: boolean,
): string {
  if (pretty) {
    const extra = Object.entries(fields)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(' ');
    return `${ts} ${level.toUpperCase().padEnd(5)} ${msg}${extra ? ' ' + extra : ''}`;
  }
  return JSON.stringify({ ts, level, msg, ...fields });
}

function emit(level: LogLevel, msg: string, fields: LogFields = {}): void {
  if (RANK[level] < RANK[envLevel()]) return;
  const pretty = (process.env.LOG_FORMAT ?? '').toLowerCase() === 'pretty';
  const line = formatLog(level, msg, fields, new Date().toISOString(), pretty) + '\n';
  // Write SYNCHRONOUSLY (fd 1/2). The async stream .write() is buffered when
  // output is a pipe (e.g. `npm run dev`), so lines can be lost if the process
  // exits right after — which made a crash look silent. Volume here is low
  // enough that synchronous logging is fine.
  try {
    writeSync(level === 'warn' || level === 'error' ? 2 : 1, line);
  } catch {
    /* stdout/stderr closed — nothing else we can do */
  }
}

export const log = {
  debug: (msg: string, fields?: LogFields) => emit('debug', msg, fields),
  info: (msg: string, fields?: LogFields) => emit('info', msg, fields),
  warn: (msg: string, fields?: LogFields) => emit('warn', msg, fields),
  error: (msg: string, fields?: LogFields) => emit('error', msg, fields),
};
