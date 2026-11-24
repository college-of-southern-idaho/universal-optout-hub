/**
 * Reference Twilio sender wired to the hub's consent-check API (ADR-0004).
 *
 * Example code for the org's custom Twilio texting app. Every send is gated on
 * the hub: `mayContact()` first, and Twilio's Messages API is called ONLY for
 * recipients the hub returns `allow` for. A suppressed recipient — or any hub
 * failure — is withheld, never sent.
 */

import { mayContact, type GateConfig } from '../consent-gate/consent-gate.js';

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  /** A phone number (`+1...`) or a Messaging Service SID (`MG...`). */
  from: string;
}

export interface SendOutcome {
  to: string;
  sent: boolean;
  reason: string;
  sid?: string;   // Twilio message SID when sent
}

/** Send one SMS, gated on the hub. */
export async function sendSms(
  gate: GateConfig,
  twilio: TwilioConfig,
  to: string,
  body: string,
): Promise<SendOutcome> {
  const [decision] = await mayContact(gate, [to]);
  if (!decision.send) return { to, sent: false, reason: `withheld — ${decision.reason}` };
  const sid = await twilioCreateMessage(twilio, to, body);
  return { to, sent: true, reason: 'allowed by hub', sid };
}

/**
 * Send one message to many recipients. Checks the whole list in a single hub
 * call (the recommended pattern), then sends only to the allowed recipients.
 * Returns an outcome per recipient — withheld ones included, for your audit.
 */
export async function sendCampaign(
  gate: GateConfig,
  twilio: TwilioConfig,
  recipients: string[],
  body: string,
): Promise<SendOutcome[]> {
  const decisions = await mayContact(gate, recipients);
  const outcomes: SendOutcome[] = [];
  for (const d of decisions) {
    if (!d.send) {
      outcomes.push({ to: d.identity, sent: false, reason: `withheld — ${d.reason}` });
      continue;
    }
    try {
      const sid = await twilioCreateMessage(twilio, d.identity, body);
      outcomes.push({ to: d.identity, sent: true, reason: 'allowed by hub', sid });
    } catch (e: any) {
      outcomes.push({ to: d.identity, sent: false, reason: `twilio error — ${e.message}` });
    }
  }
  return outcomes;
}

async function twilioCreateMessage(cfg: TwilioConfig, to: string, body: string): Promise<string> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.accountSid)}/Messages.json`;
  const form = new URLSearchParams({ To: to, Body: body });
  if (cfg.from.startsWith('MG')) form.set('MessagingServiceSid', cfg.from);
  else form.set('From', cfg.from);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Twilio send failed (${res.status}): ${json.message ?? res.statusText}`);
  return json.sid;
}
