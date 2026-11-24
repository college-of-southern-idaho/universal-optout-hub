import { createHmac, createPublicKey, verify as nodeVerify, timingSafeEqual } from 'node:crypto';
import type { Direction } from '../core/types.js';

/**
 * Inbound webhook mapping + signature verification (DESIGN §8, roadmap "inbound
 * events → ingest"). Pure functions here; the routes in api/server.ts verify the
 * signature, map the payload, and hand each event to ingest(). This is how a
 * consumer's STOP on Twilio or unsubscribe on SendGrid reconciles back into the
 * hub and then propagates (§10).
 */

export interface MappedEvent {
  direction: Direction;
  identity: string;      // raw, as the platform reports it; ingest normalizes
  occurred_at?: Date;
  detail: string;        // human-readable source_detail
  eventId?: string;      // platform's unique id for this event (replay/retry dedup)
  routeMsSid?: string;   // Twilio Event Streams only: source Messaging Service SID, for per-system routing
}

/**
 * Replay defense: is a webhook's signed timestamp recent enough to accept?
 * The timestamp is part of the signed payload, so an attacker can't move it
 * without breaking the signature — rejecting stale timestamps blocks replay of
 * old captured requests. `toleranceSec <= 0` disables the check.
 */
export function withinClockSkew(eventTimeMs: number, nowMs: number, toleranceSec: number): boolean {
  if (toleranceSec <= 0) return true;
  if (!Number.isFinite(eventTimeMs)) return false;
  return Math.abs(nowMs - eventTimeMs) <= toleranceSec * 1000;
}

// --- Twilio inbound SMS (STOP/START) -----------------------------------------

// Keyword families Twilio recognizes for Advanced Opt-Out; we also parse the
// message body as a fallback when OptOutType isn't present.
const STOP_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'revoke', 'optout']);
const START_WORDS = new Set(['start', 'yes', 'unstop', 'subscribe', 'optin']);

/**
 * Map a Twilio inbound-message webhook to a consent event, or null if it isn't
 * a consent keyword (a normal inbound text, HELP, etc.). Prefers Twilio's
 * `OptOutType` (Advanced Opt-Out) and falls back to the first word of `Body`.
 */
export function mapTwilioInbound(body: Record<string, string>): MappedEvent | null {
  const from = body.From ?? body.from;
  if (!from) return null;
  const eventId = body.MessageSid || body.SmsSid || body.SmsMessageSid || undefined;
  const tag = (ev: Omit<MappedEvent, 'eventId'>): MappedEvent => ({ ...ev, eventId });

  const optOutType = (body.OptOutType ?? '').toUpperCase();
  if (optOutType === 'STOP') return tag({ direction: 'opt_out', identity: from, detail: 'Twilio inbound STOP (OptOutType)' });
  if (optOutType === 'START') return tag({ direction: 'opt_in', identity: from, detail: 'Twilio inbound START (OptOutType)' });
  if (optOutType === 'HELP') return null;

  const word = (body.Body ?? body.body ?? '').trim().toLowerCase().split(/\s+/)[0];
  if (STOP_WORDS.has(word)) return tag({ direction: 'opt_out', identity: from, detail: `Twilio inbound keyword: ${word}` });
  if (START_WORDS.has(word)) return tag({ direction: 'opt_in', identity: from, detail: `Twilio inbound keyword: ${word}` });
  return null;
}

/**
 * Map a Twilio Event Streams delivery to consent events. Event Streams is an
 * account-level, ADDITIVE path: a webhook "Sink" plus a subscription to
 * `com.twilio.messaging.inbound-message.received` streams a copy of every inbound
 * message (carrying `optOutType`) here, in parallel to a Messaging Service's own
 * inbound webhook. That lets opt-outs reach the hub even when the Messaging
 * Service's one webhook is owned by a third-party app we can't repoint. Payloads
 * are CloudEvents JSON — a single object or a batched array; the event `data`
 * carries `from`/`body`/`optOutType`/`messageSid`, the envelope a `time`.
 * https://www.twilio.com/docs/events/event-types/messaging/inbound-message
 */
const TWILIO_INBOUND_EVENT = 'com.twilio.messaging.inbound-message.received';

export function mapTwilioEvents(payload: unknown): MappedEvent[] {
  const events = Array.isArray(payload) ? payload : payload ? [payload] : [];
  const out: MappedEvent[] = [];
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    const e = ev as Record<string, any>;
    if (e.type !== TWILIO_INBOUND_EVENT) continue;    // ignore any other event type on the stream
    const data = (e.data ?? {}) as Record<string, any>;
    const from = data.from ?? data.From;
    if (!from) continue;
    const eventId = data.messageSid ?? data.MessageSid ?? undefined;
    const routeMsSid = data.messagingServiceSid ?? data.MessagingServiceSid ?? undefined;
    const t = typeof e.time === 'string' ? new Date(e.time) : undefined;
    const occurred_at = t && !Number.isNaN(t.getTime()) ? t : undefined;
    const push = (direction: Direction, detail: string) =>
      out.push({ direction, identity: from, occurred_at, detail, eventId, routeMsSid });

    const optOutType = String(data.optOutType ?? '').toUpperCase();
    if (optOutType === 'STOP') { push('opt_out', 'Twilio Event Streams STOP (optOutType)'); continue; }
    if (optOutType === 'START') { push('opt_in', 'Twilio Event Streams START (optOutType)'); continue; }
    if (optOutType === 'HELP') continue;

    const word = String(data.body ?? data.Body ?? '').trim().toLowerCase().split(/\s+/)[0];
    if (STOP_WORDS.has(word)) push('opt_out', `Twilio Event Streams keyword: ${word}`);
    else if (START_WORDS.has(word)) push('opt_in', `Twilio Event Streams keyword: ${word}`);
  }
  return out;
}

/**
 * Route a Twilio Event Streams event to a hub system id. Event Streams is
 * account-level — one sink receives inbound from EVERY Messaging Service — so we
 * attribute each event to the system whose Messaging Service SID matches
 * (`msSidToSystem`), falling back to the sink URL's default system when the SID
 * isn't a registered system. This is what lets each Messaging Service carry its
 * own category, and lets some Messaging Services use per-service webhooks while
 * others rely on Event Streams (the shared messageSid dedup prevents double
 * ingest of a message that arrives on both paths).
 */
export function routeTwilioEvent(
  routeMsSid: string | undefined,
  msSidToSystem: Map<string, string>,
  fallbackSystemId: string,
): string {
  return (routeMsSid && msSidToSystem.get(routeMsSid)) || fallbackSystemId;
}

/**
 * Twilio request signature (HMAC-SHA1 over the full URL + POST params sorted by
 * key), base64. https://www.twilio.com/docs/usage/security#validating-requests
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

export function verifyTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signature: string | undefined,
): boolean {
  if (!authToken || !signature) return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// --- SendGrid Event Webhook --------------------------------------------------

const SG_OPT_OUT = new Set(['unsubscribe', 'group_unsubscribe', 'spamreport']);
const SG_OPT_IN = new Set(['group_resubscribe']);

/**
 * Map a SendGrid Event Webhook batch (JSON array) to consent events. Only
 * suppression-relevant events are mapped; deliveries/opens/clicks are ignored.
 */
export function mapSendgridEvents(payload: unknown): MappedEvent[] {
  if (!Array.isArray(payload)) return [];
  const out: MappedEvent[] = [];
  for (const e of payload) {
    const email = e && typeof e === 'object' ? (e as any).email : undefined;
    const type = e && typeof e === 'object' ? (e as any).event : undefined;
    const ts = e && typeof e === 'object' ? (e as any).timestamp : undefined;
    const eventId = e && typeof e === 'object' ? (e as any).sg_event_id : undefined;
    if (!email || typeof type !== 'string') continue;
    const occurred_at = typeof ts === 'number' ? new Date(ts * 1000) : undefined;
    if (SG_OPT_OUT.has(type)) out.push({ direction: 'opt_out', identity: email, occurred_at, detail: `SendGrid event: ${type}`, eventId });
    else if (SG_OPT_IN.has(type)) out.push({ direction: 'opt_in', identity: email, occurred_at, detail: `SendGrid event: ${type}`, eventId });
  }
  return out;
}

/**
 * Verify a SendGrid Event Webhook signature. Per SendGrid's official Signed
 * Event Webhook spec, this is **ECDSA with SHA-256** (NOT Ed25519): the payload
 * is `timestamp + raw request body` (raw bytes — never re-serialized JSON), the
 * signature is a base64 DER-encoded ECDSA signature, and the verification key
 * is the base64 SPKI EC (P-256) public key shown in the Signed Event Webhook
 * settings. Headers: X-Twilio-Email-Event-Webhook-Signature / -Timestamp.
 * https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/getting-started-event-webhook-security-features
 */
export function verifySendgridSignature(
  publicKeyB64: string,
  rawBody: Buffer,
  signatureB64: string | undefined,
  timestamp: string | undefined,
): boolean {
  if (!publicKeyB64 || !signatureB64 || !timestamp) return false;
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' });
    const signed = Buffer.concat([Buffer.from(timestamp, 'utf8'), rawBody]);
    // EC key + 'sha256' → ECDSA-SHA256; DER signature encoding is Node's default.
    return nodeVerify('sha256', signed, key, Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}

// --- Telesign inbound MO callback (STOP/START) -------------------------------

/**
 * Map a Telesign Messaging Mobile-Originated (MO) callback to a consent event.
 * Telesign detects the keyword and reports `user_response.action` as one of
 * stop / start / help / generic; only stop and start are consent events. The
 * phone number carries the country code without a leading '+', which we add so
 * ingest normalizes it as E.164.
 */
export function mapTelesignInbound(payload: unknown): MappedEvent | null {
  const ur = (payload as any)?.user_response;
  if (!ur || typeof ur !== 'object') return null;
  const phone: string | undefined = ur.phone_number;
  if (!phone) return null;
  const identity = phone.startsWith('+') ? phone : `+${phone}`;
  const action = String(ur.action ?? '').toLowerCase();
  const keyword = ur.keyword ? ` (keyword: ${ur.keyword})` : '';
  const ts = (payload as any)?.submit_timestamp;
  const occurred_at = ts && !Number.isNaN(Date.parse(ts)) ? new Date(ts) : undefined;
  const eventId = (payload as any)?.reference_id || undefined;
  if (action === 'stop') return { direction: 'opt_out', identity, occurred_at, detail: `Telesign inbound STOP${keyword}`, eventId };
  if (action === 'start') return { direction: 'opt_in', identity, occurred_at, detail: `Telesign inbound START${keyword}`, eventId };
  return null; // help / generic / anything else is not a consent event
}

/**
 * The Telesign callback signature: base64(HMAC-SHA256(secret, rawBody)) where
 * the secret is the BASE64-DECODED API key and the message is the raw callback
 * body only (Telesign signs the body, not the URL). Telesign sends it as
 * `Authorization: TSA {CustomerID}:{Signature}` (or X-TS-Authorization).
 * https://developer.telesign.com/enterprise/docs/authenticate-callbacks
 */
export function telesignCallbackSignature(apiKey: string, rawBody: Buffer): string {
  return createHmac('sha256', Buffer.from(apiKey, 'base64')).update(rawBody).digest('base64');
}

/** Pull the signature out of a `TSA {customerId}:{signature}` auth header. */
export function parseTelesignAuthHeader(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^TSA\s+[^:]+:(.+)$/.exec(header.trim());
  return m ? m[1].trim() : null;
}

export function verifyTelesignSignature(
  apiKey: string,
  rawBody: Buffer,
  authHeader: string | undefined,
): boolean {
  const given = parseTelesignAuthHeader(authHeader);
  if (!apiKey || !given) return false;
  try {
    const expected = Buffer.from(telesignCallbackSignature(apiKey, rawBody));
    const givenBuf = Buffer.from(given);
    return expected.length === givenBuf.length && timingSafeEqual(expected, givenBuf);
  } catch {
    return false;
  }
}
