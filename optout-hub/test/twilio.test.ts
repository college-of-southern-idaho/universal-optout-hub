import test from 'node:test';
import assert from 'node:assert/strict';
import { mapTwilioServices, mapTwilioPhoneNumbers, mapTwilioShortCodes } from '../src/adapters/twilio.js';
import { liveAdapterTypes } from '../src/adapters/registry.js';

test('mapTwilioServices maps Messaging Services to pool nodes', () => {
  const nodes = mapTwilioServices([
    { sid: 'MG111', friendly_name: 'Admissions' },
    { sid: 'MG222', friendly_name: 'Alerts' },
  ]);
  assert.deepEqual(nodes, [
    { kind: 'pool', external_ref: 'MG111', label: 'Admissions', parent_ref: null },
    { kind: 'pool', external_ref: 'MG222', label: 'Alerts', parent_ref: null },
  ]);
});

test('mapTwilioServices tolerates missing name and junk input', () => {
  assert.deepEqual(mapTwilioServices([{ sid: 'MG333' }]), [
    { kind: 'pool', external_ref: 'MG333', label: null, parent_ref: null },
  ]);
  assert.deepEqual(mapTwilioServices(null), []);
  assert.deepEqual(mapTwilioServices(undefined), []);
  assert.deepEqual(mapTwilioServices([null, {}, { sid: 'MG444' }]), [
    { kind: 'pool', external_ref: 'MG444', label: null, parent_ref: null },
  ]);
});

test('registry registers twilio as a live adapter type', () => {
  assert.ok(liveAdapterTypes().includes('twilio'));
});

test('mapTwilioPhoneNumbers maps numbers to code nodes under their service', () => {
  const nodes = mapTwilioPhoneNumbers(
    [
      { sid: 'PN1', phone_number: '+12085551234' },
      { sid: 'PN2', phone_number: '+12085555678' },
    ],
    'MG111',
  );
  assert.deepEqual(nodes, [
    { kind: 'code', external_ref: '+12085551234', label: '+12085551234', parent_ref: 'MG111' },
    { kind: 'code', external_ref: '+12085555678', label: '+12085555678', parent_ref: 'MG111' },
  ]);
});

test('mapTwilioShortCodes maps short codes to code nodes under their service', () => {
  const nodes = mapTwilioShortCodes([{ sid: 'SC1', short_code: '12345' }], 'MG222');
  assert.deepEqual(nodes, [
    { kind: 'code', external_ref: '12345', label: '12345', parent_ref: 'MG222' },
  ]);
});

test('code mappers tolerate junk and drop entries with no usable ref', () => {
  assert.deepEqual(mapTwilioPhoneNumbers(null, 'MG1'), []);
  assert.deepEqual(mapTwilioShortCodes(undefined, 'MG1'), []);
  // falls back to sid when phone_number/short_code is absent; drops truly empty
  assert.deepEqual(mapTwilioPhoneNumbers([{ sid: 'PN9' }, {}], 'MG1'), [
    { kind: 'code', external_ref: 'PN9', label: null, parent_ref: 'MG1' },
  ]);
});
