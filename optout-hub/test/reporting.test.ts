import test from 'node:test';
import assert from 'node:assert/strict';
import {
  businessDaysBetween, lagSeverity, packetToCsv, type IdentityPacket,
} from '../src/services/reporting.js';

const HOUR = 3600 * 1000;

test('businessDaysBetween: same instant is 0', () => {
  const d = new Date('2026-06-15T10:00:00Z');
  assert.equal(businessDaysBetween(d, d), 0);
});

test('businessDaysBetween: reversed range is 0 (never negative)', () => {
  assert.equal(
    businessDaysBetween(new Date('2026-06-15'), new Date('2026-06-10')),
    0,
  );
});

test('businessDaysBetween: Mon→Tue is 1', () => {
  // 2026-06-15 is a Monday.
  assert.equal(
    businessDaysBetween(new Date('2026-06-15T09:00:00'), new Date('2026-06-16T09:00:00')),
    1,
  );
});

test('businessDaysBetween: Fri→Mon skips the weekend (1)', () => {
  // 2026-06-19 Fri → 2026-06-22 Mon: Sat/Sun skipped, Mon counts.
  assert.equal(
    businessDaysBetween(new Date('2026-06-19T09:00:00'), new Date('2026-06-22T09:00:00')),
    1,
  );
});

test('businessDaysBetween: a full week is 5 business days', () => {
  assert.equal(
    businessDaysBetween(new Date('2026-06-15T09:00:00'), new Date('2026-06-22T09:00:00')),
    5,
  );
});

test('lagSeverity: within target is ok', () => {
  assert.equal(lagSeverity(5 * HOUR, 24 * HOUR, 0), 'ok');
});

test('lagSeverity: over operational target but within ceiling is warn', () => {
  assert.equal(lagSeverity(30 * HOUR, 24 * HOUR, 1), 'warn');
});

test('lagSeverity: past the 10-business-day ceiling is breach', () => {
  assert.equal(lagSeverity(500 * HOUR, 24 * HOUR, 11), 'breach');
});

test('lagSeverity: exactly 10 business days is not yet a breach', () => {
  assert.equal(lagSeverity(500 * HOUR, 24 * HOUR, 10), 'warn');
});

function packet(events: Array<Record<string, unknown>>): IdentityPacket {
  return {
    identity: { id: 1, kind: 'phone', value_normalized: '+12085550142', value_raw: '208-555-0142', created_at: new Date() },
    reachability: { currently_reachable: [], suppressed_or_opted_out: [], summary: '' },
    states: [], events, approvals: [], alerts: [],
  };
}

test('packetToCsv: header only when no events', () => {
  const csv = packetToCsv(packet([]));
  assert.equal(csv.split('\r\n').length, 1);
  assert.match(csv, /^occurred_at,received_at,system_id/);
});

test('packetToCsv: escapes commas, quotes, and newlines', () => {
  const csv = packetToCsv(packet([{
    occurred_at: '2026-06-15T00:00:00Z', system_id: 'twilio_custom', direction: 'opt_in',
    source_detail: 'web form, v2', consent_language: 'I agree to "texts"\nand more',
  }]));
  const dataLine = csv.split('\r\n')[1];
  assert.ok(dataLine.includes('"web form, v2"'), 'comma field quoted');
  assert.ok(dataLine.includes('"I agree to ""texts""'), 'quotes doubled and field wrapped');
});

test('packetToCsv: missing fields render empty, columns stay aligned', () => {
  const csv = packetToCsv(packet([{ system_id: 'anthology_reach', direction: 'opt_out' }]));
  const cells = csv.split('\r\n')[1].split(',');
  assert.equal(cells.length, 11);            // one cell per column
  assert.equal(cells[0], '');                // occurred_at absent
  assert.equal(cells[2], 'anthology_reach'); // system_id present
});
