/**
 * Reference email-to-SMS gateway sender wired to the hub's consent-check API
 * (ADR-0004, Class B). Example code for the org's own sender — not the hub.
 *
 * A carrier email-to-SMS gateway delivers a text by EMAILING `<number>@<carrier
 * domain>` (e.g. 2085550123@vtext.com). Transport is SMTP, but for CONSENT the
 * recipient is a phone number on the SMS channel — so the gate is called with
 * `channel: 'sms'` and the phone numbers, exactly like the Twilio sender. This
 * is the withhold-only enforcement path: the gateway keeps no suppression list,
 * so opt-out is enforced here by asking the hub before each send and failing
 * closed (degrading to the local cache on a hub outage).
 *
 * The SMTP client is injected (`MailTransport`, shaped like nodemailer's
 * `transporter.sendMail`) so this file has no dependencies beyond the shared
 * gate — plug in nodemailer or any SMTP library in your sender.
 */

import { mayContact, type GateConfig } from '../consent-gate/consent-gate.js';

/** Minimal SMTP sink — matches nodemailer's `sendMail`. */
export interface MailTransport {
  sendMail(msg: { from: string; to: string; text: string; subject?: string }): Promise<{ messageId?: string }>;
}

export interface GatewayConfig {
  from: string;                                       // envelope From (e.g. alerts@example.edu)
  /** Carrier gateway domain, fixed or resolved per number (carrier lookup). */
  carrierDomain: string | ((phone: string) => string);
}

export interface SendOutcome {
  to: string;                 // the phone number (the consent identity)
  sent: boolean;
  reason: string;
  messageId?: string;
}

/**
 * Pure: build the carrier gateway address for a phone number. Strips to digits
 * and drops a leading US country code, then `<local>@<carrierDomain>`.
 */
export function gatewayAddress(phone: string, carrierDomain: string): string {
  const digits = phone.replace(/\D/g, '');
  const local = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  return `${local}@${carrierDomain}`;
}

function resolveCarrier(cfg: GatewayConfig, phone: string): string {
  return typeof cfg.carrierDomain === 'function' ? cfg.carrierDomain(phone) : cfg.carrierDomain;
}

/** Send one text via the gateway, gated on the hub. `gate.channel` must be 'sms'. */
export async function sendSms(
  gate: GateConfig,
  transport: MailTransport,
  cfg: GatewayConfig,
  to: string,
  body: string,
): Promise<SendOutcome> {
  const [decision] = await mayContact(gate, [to]);
  if (!decision.send) return { to, sent: false, reason: `withheld — ${decision.reason}` };
  try {
    const r = await transport.sendMail({ from: cfg.from, to: gatewayAddress(to, resolveCarrier(cfg, to)), text: body });
    return { to, sent: true, reason: 'allowed by hub', messageId: r.messageId };
  } catch (e: any) {
    return { to, sent: false, reason: `gateway error — ${e.message}` };
  }
}

/**
 * Send one message to many numbers. Checks the whole list in a single hub call,
 * then emails the gateway only for allowed recipients. Returns an outcome per
 * recipient — withheld ones included, for your audit.
 */
export async function sendCampaign(
  gate: GateConfig,
  transport: MailTransport,
  cfg: GatewayConfig,
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
      const r = await transport.sendMail({ from: cfg.from, to: gatewayAddress(d.identity, resolveCarrier(cfg, d.identity)), text: body });
      outcomes.push({ to: d.identity, sent: true, reason: 'allowed by hub', messageId: r.messageId });
    } catch (e: any) {
      outcomes.push({ to: d.identity, sent: false, reason: `gateway error — ${e.message}` });
    }
  }
  return outcomes;
}
