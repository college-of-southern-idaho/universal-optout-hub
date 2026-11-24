# Reference: custom Twilio sender wired to the consent-check API

Example integration for the **org's own Twilio texting app** — the "custom texting solution built on Twilio." The hub is never in the send path (DESIGN §3); for a withhold-only platform like Twilio, opt-out is enforced *here in the sender* by asking the hub before each send and **failing closed** (ADR-0004).

This is illustrative code to copy into your sender, not part of the hub runtime. It has no dependencies beyond `fetch` (Node 20+).

## The pieces

- **Shared gate** — [`../consent-gate/consent-gate.ts`](../consent-gate/consent-gate.ts): `mayContact(cfg, identities)` calls `POST /api/v1/consent/check` and returns a send/withhold decision per identity. `decide()` is the pure fail-closed rule: only an explicit `allow` permits a send; a suppression, an un-evaluable identity, or a hub failure withholds. With a `cache` configured (see below), a hub **outage** degrades to the last-known suppression list instead of withholding everything.
- **Shared cache** — [`../consent-gate/suppression-cache.ts`](../consent-gate/suppression-cache.ts): `SuppressionCache` + `syncSuppressions()` pull the hub's suppression feed (`GET /api/v1/consent/suppressions`) so the gate can fail *to cache* on an outage (ADR-0004 §2.4). The same gate/cache are shared with the [email-to-SMS gateway sender](../email-sms-gateway-sender/).
- **`send.ts`** — `sendSms()` / `sendCampaign()` gate on `mayContact()` and call Twilio's Messages API only for allowed recipients.

## Usage

```ts
import { sendCampaign } from './send.js';

const gate = {
  hubUrl: process.env.HUB_URL!,        // https://hub.example.edu
  apiKey: process.env.HUB_API_KEY!,    // oohk_...  (Admin → Services → Consent-check API keys)
  system: 'admissions_twilio',         // the system id the key is scoped to
  channel: 'sms' as const,
};
const twilio = {
  accountSid: process.env.TWILIO_ACCOUNT_SID!,
  authToken: process.env.TWILIO_AUTH_TOKEN!,
  from: process.env.TWILIO_FROM!,      // +1... number or MG... Messaging Service SID
};

const outcomes = await sendCampaign(gate, twilio, ['+12084207280', '+12085550101'], 'Welcome!');
for (const o of outcomes) console.log(o.to, o.sent ? `sent ${o.sid}` : o.reason);
```

## The contract that matters

- **Fail closed.** If the hub is unreachable, times out, or returns anything other than a clear `allow`, the recipient is **not** messaged. Over-suppression is free; under-suppression is a TCPA violation (DESIGN §2.4).
- **`allow` ≠ consent.** An `allow` means only "no revocation on record." Your app still needs its own lawful basis to contact the recipient (see the `advisory` in each result).
- **Batch up front.** `sendCampaign` checks the whole recipient list in one hub call, then sends. Don't make a synchronous per-message call at fan-out.
- **Availability.** A hard hub dependency on every send is a risk (ADR-0002 SPOF). Pass a `cache` (a `SuppressionCache` fed by `syncSuppressions()`) in the gate config so a hub **outage** degrades to the last-known suppression list rather than withholding everything (ADR-0004 §2.4). Run `syncSuppressions()` on a schedule (every 30–60s); the cache stays warm and the live check still runs first for freshness. Without a ready cache, an outage fails closed.
