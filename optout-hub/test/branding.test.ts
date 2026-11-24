import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBranding } from '../src/core/branding.js';

test('resolveBranding accepts valid values and lowercases hex', () => {
  const b = resolveBranding({ org_name: '  Acme U  ', accent_color: '#1F4AB8', bg_color: '#EEEEEE' });
  assert.equal(b.org_name, 'Acme U');
  assert.equal(b.accent_color, '#1f4ab8');
  assert.equal(b.bg_color, '#eeeeee');
  assert.equal(b.logo_data, null);
});

test('resolveBranding treats blanks/omitted as cleared (all fields null)', () => {
  assert.deepEqual(resolveBranding({}), {
    org_name: null, browser_title: null, logo_data: null, favicon_data: null,
    accent_color: null, bg_color: null, header_color: null, text_color: null,
    card_color: null, optin_color: null, optout_color: null, suppressed_color: null,
  });
  assert.equal(resolveBranding({ org_name: '', accent_color: '' }).org_name, null);
});

test('resolveBranding rejects bad hex colors across the palette', () => {
  assert.throws(() => resolveBranding({ accent_color: 'blue' }), /hex color/);
  assert.throws(() => resolveBranding({ bg_color: '#12345' }), /hex color/);
  assert.throws(() => resolveBranding({ header_color: 'rgb(0,0,0)' }), /hex color/);
  assert.throws(() => resolveBranding({ optout_color: '#zzzzzz' }), /hex color/);
});

test('resolveBranding accepts the full palette + browser title', () => {
  const b = resolveBranding({
    browser_title: '  Acme Console  ',
    header_color: '#101820', text_color: '#222222', card_color: '#FAFAFA',
    optin_color: '#0A7E4F', optout_color: '#AA3322', suppressed_color: '#556677',
  });
  assert.equal(b.browser_title, 'Acme Console');
  assert.equal(b.header_color, '#101820');
  assert.equal(b.card_color, '#fafafa');       // lowercased
  assert.equal(b.optin_color, '#0a7e4f');
});

test('resolveBranding validates favicon like the logo', () => {
  const ico = 'data:image/x-icon;base64,AAAB';
  assert.equal(resolveBranding({ favicon_data: ico }).favicon_data, ico);
  assert.throws(() => resolveBranding({ favicon_data: 'data:text/html;base64,AAAA' }), /uploaded image or an https/);
  assert.throws(() => resolveBranding({ favicon_data: 'data:image/png;base64,' + 'A'.repeat(200_001) }), /too large/);
});

test('resolveBranding accepts a data: image URL and https URL', () => {
  const data = 'data:image/png;base64,iVBORw0KGgo=';
  assert.equal(resolveBranding({ logo_data: data }).logo_data, data);
  assert.equal(resolveBranding({ logo_data: 'https://cdn.example.com/logo.png' }).logo_data, 'https://cdn.example.com/logo.png');
});

test('resolveBranding rejects a non-image / non-https logo and oversize data', () => {
  assert.throws(() => resolveBranding({ logo_data: 'http://insecure/logo.png' }), /uploaded image or an https/);
  assert.throws(() => resolveBranding({ logo_data: 'data:text/html;base64,AAAA' }), /uploaded image or an https/);
  assert.throws(() => resolveBranding({ logo_data: 'data:image/png;base64,' + 'A'.repeat(700_001) }), /too large/);
});
