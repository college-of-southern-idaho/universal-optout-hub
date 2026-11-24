import test from 'node:test';
import assert from 'node:assert/strict';
import { formatLog } from '../src/core/logger.js';

const TS = '2026-08-27T12:00:00.000Z';

test('json format emits a single object with stable leading fields', () => {
  const line = formatLog('info', 'http_request', { reqId: 'abc', status: 200 }, TS, false);
  assert.equal(line, '{"ts":"2026-08-27T12:00:00.000Z","level":"info","msg":"http_request","reqId":"abc","status":200}');
  // Round-trips as valid JSON.
  const obj = JSON.parse(line);
  assert.equal(obj.level, 'info');
  assert.equal(obj.reqId, 'abc');
});

test('json format is safe with no extra fields', () => {
  assert.equal(
    formatLog('warn', 'started', {}, TS, false),
    '{"ts":"2026-08-27T12:00:00.000Z","level":"warn","msg":"started"}',
  );
});

test('pretty format is human-readable with padded level and key=value extras', () => {
  const line = formatLog('error', 'boom', { code: 500, where: 'db' }, TS, true);
  assert.equal(line, '2026-08-27T12:00:00.000Z ERROR boom code=500 where=db');
});

test('pretty format leaves string values unquoted but JSON-encodes non-strings', () => {
  const line = formatLog('info', 'msg', { s: 'plain', n: 3, b: true }, TS, true);
  assert.equal(line, '2026-08-27T12:00:00.000Z INFO  msg s=plain n=3 b=true');
});
