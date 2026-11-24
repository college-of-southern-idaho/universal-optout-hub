import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';

/**
 * Azure Function (v4 model): the inbound side of the Twilio ↔ Consent Hub
 * integration. Twilio's Messaging Service has ONE inbound webhook, and yours
 * already points at your custom texting app — so DON'T repoint it at the hub.
 * Instead, keep this as (or fold it into) your existing inbound handler, and
 * relay STOP/START to the hub via POST /api/v1/consent/report. Your normal
 * inbound processing (conversations, campaign replies) stays untouched.
 *
 * Config (Function App settings; back CONSENT_HUB_API_KEY with a Key Vault ref):
 *   CONSENT_HUB_BASE       https://your-hub-domain.edu
 *   CONSENT_HUB_SYSTEM_ID  the Twilio system id in the hub (e.g. twilio_csi)
 *   CONSENT_HUB_API_KEY    the per-system key (Admin → Services → Consent-check API keys)
 */

// Twilio's default opt-out / opt-in keyword families (matches the hub's parser).
const STOP_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'revoke', 'optout']);
const START_WORDS = new Set(['start', 'yes', 'unstop', 'subscribe', 'optin']);

/**
 * Map a Twilio inbound message to a consent direction, or null if it isn't a
 * consent keyword (an ordinary reply). Prefers Twilio's `OptOutType` (Advanced
 * Opt-Out) and falls back to the first word of the message body.
 */
export function consentDirection(optOutType: string, body: string): 'opt_out' | 'opt_in' | null {
  const t = (optOutType || '').toUpperCase();
  if (t === 'STOP') return 'opt_out';
  if (t === 'START') return 'opt_in';
  const word = (body || '').trim().toLowerCase().split(/\s+/)[0] ?? '';
  if (STOP_WORDS.has(word)) return 'opt_out';
  if (START_WORDS.has(word)) return 'opt_in';
  return null;
}

/** Best-effort report to the hub. Never throws — a hub hiccup must not fail Twilio's webhook. */
async function reportConsent(value: string, direction: 'opt_out' | 'opt_in', ctx: InvocationContext): Promise<void> {
  const base = process.env.CONSENT_HUB_BASE;
  const key = process.env.CONSENT_HUB_API_KEY;
  const system = process.env.CONSENT_HUB_SYSTEM_ID;
  if (!base || !key || !system) {
    ctx.warn('CONSENT_HUB_* settings are not fully configured; skipping consent report');
    return;
  }
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/api/v1/consent/report`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ system, value, direction, source: 'twilio inbound' }),
    });
    if (!res.ok) ctx.warn(`consent report ${res.status}: ${await res.text()}`);
    else ctx.log(`reported ${direction} for ${value} to the consent hub`);
  } catch (e) {
    // Best-effort: log and continue. For guaranteed delivery, enqueue and retry.
    ctx.error('consent report failed (continuing)', e);
  }
}

app.http('twilioInbound', {
  methods: ['POST'],
  authLevel: 'function', // Twilio calls a URL with a ?code=… function key; also validate the X-Twilio-Signature below.
  handler: async (request: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> => {
    // Twilio posts application/x-www-form-urlencoded.
    const form = await request.formData();
    const from = String(form.get('From') ?? '');
    const body = String(form.get('Body') ?? '');
    const optOutType = String(form.get('OptOutType') ?? '');

    // NOTE: validate Twilio's X-Twilio-Signature over the exact request URL +
    // sorted params here (your existing handler likely already does this).

    // ---- your existing inbound handling stays here (conversations, etc.) ----

    // Relay a consent change to the hub, if this message is one.
    const direction = consentDirection(optOutType, body);
    if (direction && from) await reportConsent(from, direction, ctx);

    // Respond to Twilio exactly as you do today (empty TwiML shown here).
    return { status: 200, headers: { 'Content-Type': 'text/xml' }, body: '<Response/>' };
  },
});
