# Reference: Azure Function — relay Twilio STOP/START to the Consent Hub

The **inbound** side of the Twilio ↔ hub integration, for an org whose custom
texting app runs on **Azure Functions**. It's the companion to the outbound
[`twilio-sender`](../twilio-sender/) example (which gates *sends* on the hub).

## Why this exists

A Twilio Messaging Service has exactly **one** inbound-message webhook, and yours
already points at your texting app (for conversations, campaign replies, etc.).
Repointing it at the hub would break that. So instead of Twilio calling the hub,
**your app relays the consent event** to the hub — keeping your Twilio config
unchanged. When your inbound function sees a **STOP** (or **START**), it calls the
hub's write endpoint:

```
POST /api/v1/consent/report
{ "system": "twilio_csi", "value": "+12084207280", "direction": "opt_out", "source": "twilio inbound" }
```

The hub records it and **propagates the opt-out to every other platform**, so one
STOP means opted-out everywhere.

## What's here

- `src/functions/twilioInbound.ts` — an Azure Functions **v4** HTTP handler.
  `consentDirection()` maps Twilio's `OptOutType` / message `Body` to
  `opt_out`/`opt_in` (matching the hub's own keyword parser); `reportConsent()`
  POSTs it to the hub, **best-effort** (a hub hiccup never fails Twilio's webhook).
  Fold this into your existing inbound function — the consent relay is the only
  new part; your normal inbound handling stays.
- `package.json`, `host.json`, `tsconfig.json`, `local.settings.json.example` —
  a self-contained, deployable Function App (its own deps; excluded from the hub's build).

## Configure

Copy `local.settings.json.example` → `local.settings.json` (or set these as
**Function App settings** in Azure) and fill in:

| Setting | Value |
|---|---|
| `CONSENT_HUB_BASE` | your hub's public URL, e.g. `https://consent.example.edu` |
| `CONSENT_HUB_SYSTEM_ID` | the Twilio system id in the hub (e.g. `twilio_csi`) |
| `CONSENT_HUB_API_KEY` | the per-system key from **Admin → Services → configure the Twilio service → Consent-check API keys** |

Back `CONSENT_HUB_API_KEY` with a **Key Vault reference**, not plaintext.

## Run / deploy

```bash
npm install
npm run build
npm start          # local: func start  (needs Azure Functions Core Tools)
```
Deploy with `func azure functionapp publish <your-app>` (or your CI). This example
is standalone — it is **not** part of the hub build.

## Notes

- **Additive & non-breaking.** Twilio's inbound webhook and status/delivery
  callbacks stay pointed at your app. This only *adds* an outbound call to the hub.
- **Validate the Twilio signature.** Your inbound handler should verify
  `X-Twilio-Signature` over the exact request URL + params (your app likely
  already does). This example focuses on the consent relay.
- **Safe to retry.** Re-reporting the same STOP is idempotent in outcome. For
  guaranteed delivery under a hub outage, enqueue the event (Storage/Service Bus)
  and report from a queue-triggered function with retries.
- **Same key, both directions.** The per-system key also authorizes the pre-send
  `POST /api/v1/consent/check` call (see [`twilio-sender`](../twilio-sender/)).
