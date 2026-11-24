/**
 * Branding settings — a deployment can make the console its own without
 * recompiling: names, a logo/favicon, a browser title, and a color palette.
 * PUT replaces the whole set; an omitted/blank field clears that aspect back
 * to the built-in default. Presentation only — no branding value is ever read
 * by a consent decision.
 *
 * Migration 008 introduced org_name/logo/accent/bg; 010 added the fuller
 * palette, favicon, and browser title.
 */
export interface Branding {
  org_name: string | null;
  browser_title: string | null;
  logo_data: string | null;        // data: URL (uploaded) or https URL
  favicon_data: string | null;     // data: URL (uploaded) or https URL
  accent_color: string | null;     // #rrggbb — accents / links / buttons
  bg_color: string | null;         // #rrggbb — page background
  header_color: string | null;     // #rrggbb — header bar
  text_color: string | null;       // #rrggbb — body text
  card_color: string | null;       // #rrggbb — card surfaces
  optin_color: string | null;      // #rrggbb — opt-in status
  optout_color: string | null;     // #rrggbb — opt-out status
  suppressed_color: string | null; // #rrggbb — suppressed status
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const IMG = /^data:image\/(png|jpeg|gif|webp|svg\+xml|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/=]+$/;
const LOGO_MAX = 700_000;      // ~512KB binary once base64-encoded
const FAVICON_MAX = 200_000;   // favicons are small; cap tighter

function text(v: unknown, max: number, name: string): string | null {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (s.length > max) throw new Error(`${name} too long (max ${max} characters)`);
  return s || null;
}

function hex(v: unknown, name: string): string | null {
  if (v == null || v === '') return null;
  const s = String(v);
  if (!HEX.test(s)) throw new Error(`${name} must be a #rrggbb hex color`);
  return s.toLowerCase();
}

function image(v: unknown, name: string, max: number): string | null {
  if (v == null || v === '') return null;
  const s = String(v);
  if (s.length > max) throw new Error(`${name} too large (max ~${Math.round(max / 1400)}KB)`);
  if (!IMG.test(s) && !/^https:\/\/\S+$/.test(s)) {
    throw new Error(`${name} must be an uploaded image or an https:// URL`);
  }
  return s;
}

export function resolveBranding(input: Record<string, unknown>): Branding {
  return {
    org_name: text(input.org_name, 80, 'org_name'),
    browser_title: text(input.browser_title, 120, 'browser_title'),
    logo_data: image(input.logo_data, 'logo', LOGO_MAX),
    favicon_data: image(input.favicon_data, 'favicon', FAVICON_MAX),
    accent_color: hex(input.accent_color, 'accent_color'),
    bg_color: hex(input.bg_color, 'bg_color'),
    header_color: hex(input.header_color, 'header_color'),
    text_color: hex(input.text_color, 'text_color'),
    card_color: hex(input.card_color, 'card_color'),
    optin_color: hex(input.optin_color, 'optin_color'),
    optout_color: hex(input.optout_color, 'optout_color'),
    suppressed_color: hex(input.suppressed_color, 'suppressed_color'),
  };
}
