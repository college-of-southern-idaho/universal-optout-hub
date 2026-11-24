# Reference: email-to-SMS gateway sender wired to the consent-check API

Example integration for a sender that delivers texts through a **carrier
email-to-SMS gateway** — the message is emailed to `<number>@<carrier-domain>`
(e.g. `2085550123@vtext.com`) over SMTP. It's a **Class B** withhold-only
sender: the gateway keeps no suppression list, so opt-out is enforced *here in
the sender* by asking the hub before each send and **failing closed** (ADR-0004).

Transport is email; **consent classification is SMS**. The recipient is a phone
number, so the gate is called with `channel: 'sms'` — identical to the Twilio
sender. Email-to-SMS is SMS for consent, regardless of transport (DESIGN §7).

## Pieces

- Shared gate: [`../consent-gate/consent-gate.ts`](../consent-gate/consent-gate.ts) (`mayContact` + fail-to-cache) and [`../consent-gate/suppression-cache.ts`](../consent-gate/suppression-cache.ts).
- **`send.ts`** — `sendSms()` / `sendCampaign()` gate on `mayContact()`, then email the gateway only for allowed recipients. `gatewayAddress()` builds the carrier address. The SMTP client is **injected** (`MailTransport`, shaped like nodemailer's `sendMail`) so this file has no SMTP dependency.

## Usage

```ts
import nodemailer from 'nodemailer';                 // or any SMTP client
import { sendCampaign } from './send.js';

const gate = {
  hubUrl: process.env.HUB_URL!,
  apiKey: process.env.HUB_API_KEY!,     // oohk_... scoped to this gateway system
  system: 'sms_gateway',
  channel: 'sms' as const,              // SMS for consent — NOT 'email'
};

const transport = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: 587, auth: { /* ... */ } });
const cfg = { from: 'alerts@example.edu', carrierDomain: 'vtext.com' };

const outcomes = await sendCampaign(gate, transport, cfg, ['+12084207280', '+12085550101'], 'Class is cancelled today.');
for (const o of outcomes) console.log(o.to, o.sent ? `sent ${o.messageId}` : o.reason);
```

`carrierDomain` may be a function (`(phone) => domain`) when you resolve carrier
per number.

## The contract that matters

- **Fail closed.** If the hub returns anything other than a clear `allow`, the
  number is **not** messaged. Over-suppression is free; under-suppression is a
  TCPA violation (DESIGN §2.4).
- **Outage → cache, not blind allow.** Pass a `cache` in the gate config (fed by
  `syncSuppressions()`) so a hub outage degrades to the last-known suppression
  list instead of withholding every send. Without a ready cache, an outage fails
  closed. Auth/scope/rate-limit errors (4xx) always fail closed.
- **`channel: 'sms'`.** The gate must be told SMS; sending it `'email'` checks
  the wrong channel and the hub rejects the scope.
- **Batch up front.** `sendCampaign` checks the whole list in one hub call.
