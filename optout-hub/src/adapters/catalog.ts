import type { Channel, TopologyGranularity } from '../core/types.js';

/**
 * Adapter-type catalog for the service-configuration screens (DESIGN.md §9).
 *
 * Each entry describes a kind of sending service: its default consent channel,
 * default capability flags, and the credential fields an operator must supply.
 * Defaults encode platform facts that are easy to get wrong — most importantly,
 * Telesign keeps no caller-writable suppression list (ADR-0002 §1), so its
 * can_write_optout default is FALSE and the hub enforces opt-out by withholding
 * sends rather than by writing a flag. An operator may override the editable
 * flags at registration; the credential field list is fixed per type.
 *
 * In this PoC every type is served by the mock adapter. In production each maps
 * to a real client. The catalog is the single source the UI reads to render the
 * register form, so adding a real adapter is: implement the client, add its
 * entry here. Nothing in this file is read by a consent decision.
 */

// Source of truth for the known adapter types. The systems.adapter_type CHECK
// constraint (migration 006) mirrors this list exactly.
export const ADAPTER_TYPES = [
  // Existing
  'mock', 'twilio', 'telesign', 'constant_contact', 'email_sms_gateway',
  // SMS · CPaaS / programmable messaging
  'vonage', 'sinch', 'infobip', 'bird', 'plivo', 'telnyx', 'bandwidth',
  'amazon_sns', 'azure_communication',
  // SMS · campaign / business messaging
  'attentive', 'klaviyo', 'ez_texting', 'simpletexting', 'slicktext',
  // SMS · withhold-only / vertical
  'mongoose_cadence', 'modern_campus_message',
  // Email · marketing / ESP
  'mailchimp', 'hubspot', 'activecampaign', 'brevo', 'mailerlite', 'mailjet',
  'salesforce_marketing_cloud', 'adobe_marketo', 'dynamics_journeys',
  // Email · transactional / SMTP API
  'sendgrid', 'amazon_ses', 'mailgun', 'postmark', 'mailchimp_transactional',
] as const;

export type AdapterType = typeof ADAPTER_TYPES[number];

export interface CredentialField {
  key: string;
  label: string;
  secret: boolean;      // true → write-only password input, never read back
  required: boolean;
  placeholder?: string;
  help?: string;
}

export interface AdapterTypeSpec {
  type: AdapterType;
  label: string;
  blurb: string;
  channel: Channel;
  channel_locked: boolean;  // email-to-SMS gateways MUST be 'sms' (systems CHECK)
  defaults: {
    event_delivery: 'webhook' | 'poll' | 'export';
    can_write_optout: boolean;
    can_write_optin: boolean;
    can_discover_topology: boolean;
    topology_granularity: TopologyGranularity;
  };
  credentials: CredentialField[];
  notes?: string;
}

// Builders keep the catalog readable. txt = visible field (text input), sec =
// write-only secret (password input, never read back).
const txt = (key: string, label: string, required = true, extra: Partial<CredentialField> = {}): CredentialField =>
  ({ key, label, secret: false, required, ...extra });
const sec = (key: string, label: string, required = true, extra: Partial<CredentialField> = {}): CredentialField =>
  ({ key, label, secret: true, required, ...extra });

type Defaults = AdapterTypeSpec['defaults'];
// The two consent capability patterns (DESIGN.md §9):
//  capsA — platform exposes a writable suppression/subscription surface the hub
//          can read and write, and emits opt-out events.
//  capsWithhold — no caller-writable list: opt-out means suppressing sends and
//          ingesting the platform's opt-out events.
const capsA = (event_delivery: Defaults['event_delivery'],
               topology_granularity: TopologyGranularity = 'group',
               over: Partial<Defaults> = {}): Defaults =>
  ({ event_delivery, can_write_optout: true, can_write_optin: true,
     can_discover_topology: true, topology_granularity, ...over });
const capsWithhold = (event_delivery: Defaults['event_delivery'] = 'webhook'): Defaults =>
  ({ event_delivery, can_write_optout: false, can_write_optin: false,
     can_discover_topology: false, topology_granularity: 'none' });

export const ADAPTER_CATALOG: AdapterTypeSpec[] = [
  {
    type: 'mock',
    label: 'Mock (demo)',
    blurb: 'In-memory simulated platform for the PoC and demos. No real credentials.',
    channel: 'sms',
    channel_locked: false,
    defaults: {
      event_delivery: 'webhook',
      can_write_optout: true, can_write_optin: true,
      can_discover_topology: true, topology_granularity: 'pool',
    },
    credentials: [],
    notes: 'Backs every system in this PoC. Test connection verifies the simulated platform is reachable.',
  },
  {
    type: 'twilio',
    label: 'Twilio (custom texting)',
    blurb: 'Twilio Programmable Messaging with sender pools / Messaging Services.',
    channel: 'sms',
    channel_locked: false,
    // Opt-out is now writable via the Consent Management API (bulk upsert), so
    // the hub can push an opt-out captured elsewhere TO Twilio. Opt-in stays off
    // by default (approval-gated re-subscribe is the conservative choice); it can
    // be enabled per system. Both require the Messaging Service SID (sender_id).
    defaults: {
      event_delivery: 'webhook',
      can_write_optout: true, can_write_optin: false,
      can_discover_topology: true, topology_granularity: 'pool',
    },
    credentials: [
      { key: 'account_sid', label: 'Account SID', secret: false, required: true, placeholder: 'ACxxxxxxxx' },
      { key: 'api_key_sid', label: 'API Key SID', secret: false, required: false, placeholder: 'SKxxxxxxxx', help: 'Preferred over the Auth Token — a scoped, revocable API Key (SK…) + its secret authenticate REST calls.' },
      { key: 'api_key_secret', label: 'API Key secret', secret: true, required: false, help: 'The secret shown once when you create the API Key.' },
      { key: 'auth_token', label: 'Auth token', secret: true, required: false, help: 'Optional if an API Key is set. Still required to verify inbound webhook signatures if you use the hub’s Twilio webhook.' },
      { key: 'messaging_service_sid', label: 'Messaging Service SID', secret: false, required: false, placeholder: 'MGxxxxxxxx', help: 'Required for opt-out writes and webhook provisioning (the Consent API sender_id); also scopes discovery to one sender pool.' },
    ],
    notes: 'Live client: authenticates (an API Key SK…/secret is preferred over the Auth Token), discovers Messaging Services (sender pools), pushes opt-outs via the Consent Management API, and ingests consumer STOP/START from the inbound webhook (auto-provisionable). The Consent API is write-only (no opt-out read), and needs a Messaging Service SID. Webhook signature verification uses the Auth Token, so keep it set if you use the hub’s inbound Twilio webhook.',
  },
  {
    type: 'telesign',
    label: 'Telesign (Anthology Reach)',
    blurb: 'Telesign behind Anthology Reach. Detects STOP/START and notifies by callback.',
    channel: 'sms',
    channel_locked: false,
    defaults: {
      event_delivery: 'webhook',
      // Telesign keeps no caller-writable suppression list (ADR-0002 §1): the
      // hub cannot push opt-out/opt-in state to it. Opt-out is enforced by
      // withholding sends, not by writing a flag. Defaults reflect that.
      can_write_optout: false, can_write_optin: false,
      can_discover_topology: true, topology_granularity: 'code',
    },
    credentials: [
      { key: 'customer_id', label: 'Customer ID', secret: false, required: true },
      { key: 'api_key', label: 'API key', secret: true, required: true },
    ],
    notes: 'No caller-writable suppression list. Opt-out here means withholding sends; point the Telesign Messaging MO (mobile-originated) callback at POST /api/webhooks/telesign/<system-id> to feed STOP/START into the hub (verified by HMAC-SHA256 over the body with your API key).',
  },
  {
    type: 'constant_contact',
    label: 'Constant Contact (email)',
    blurb: 'Constant Contact list subscriptions for email opt-in/opt-out.',
    channel: 'email',
    channel_locked: false,
    defaults: {
      event_delivery: 'poll',
      can_write_optout: true, can_write_optin: true,
      can_discover_topology: true, topology_granularity: 'group',
    },
    credentials: [
      { key: 'api_key', label: 'API key (client ID)', secret: false, required: true, help: "Your Constant Contact app's API key — also the OAuth client_id." },
      { key: 'client_secret', label: 'App secret (client secret)', secret: true, required: false, help: 'Required for unattended OAuth token refresh (with the refresh token).' },
      { key: 'access_token', label: 'Access token', secret: true, required: true },
      { key: 'refresh_token', label: 'Refresh token', secret: true, required: false, help: 'Lets the hub refresh the access token unattended; rotates on each refresh.' },
    ],
    notes: 'OAuth. Access tokens last ~24h — provide client_secret + refresh_token so the hub refreshes unattended. Consumer opt-outs are pulled by polling (no webhook).',
  },
  {
    type: 'email_sms_gateway',
    label: 'Email-to-SMS gateway',
    blurb: 'Carrier email-to-SMS gateway. SMS by consent classification, delivered over SMTP.',
    channel: 'sms',
    channel_locked: true,   // consent classification is SMS even though transport is email (DESIGN.md §9)
    defaults: {
      event_delivery: 'export',
      // No consent API to write to and no machine-readable groupings.
      can_write_optout: false, can_write_optin: false,
      can_discover_topology: false, topology_granularity: 'none',
    },
    credentials: [
      { key: 'smtp_host', label: 'SMTP host', secret: false, required: true, placeholder: 'smtp.example.edu' },
      { key: 'smtp_username', label: 'SMTP username', secret: false, required: true },
      { key: 'smtp_password', label: 'SMTP password', secret: true, required: true },
    ],
    notes: 'Channel is locked to SMS (consent classification, not transport). No consent API and no discoverable topology — opt-out is enforced at send time and codes are grouped by manual annotation.',
  },

  // ===== SMS · CPaaS / programmable messaging (pattern A) ====================
  {
    type: 'vonage', label: 'Vonage (Nexmo)',
    blurb: 'Vonage Messages/SMS API. Closest drop-in Twilio alternative.',
    channel: 'sms', channel_locked: true,
    defaults: capsA('webhook', 'pool'),
    credentials: [
      txt('api_key', 'API key'), sec('api_secret', 'API secret'),
      txt('application_id', 'Application ID', false),
      sec('private_key', 'Private key (PEM)', false, { help: 'For JWT-authenticated Messages API.' }),
    ],
  },
  {
    type: 'sinch', label: 'Sinch',
    blurb: 'Sinch CPaaS (SMS, also voice/WhatsApp). Parent of MessageMedia and Mailgun.',
    channel: 'sms', channel_locked: false,
    defaults: capsA('webhook', 'pool'),
    credentials: [
      txt('service_plan_id', 'Service plan ID'), sec('api_token', 'API token'),
      txt('project_id', 'Project ID', false),
    ],
  },
  {
    type: 'infobip', label: 'Infobip',
    blurb: 'Infobip enterprise omnichannel CPaaS.',
    channel: 'sms', channel_locked: false,
    defaults: capsA('webhook', 'pool'),
    credentials: [
      txt('base_url', 'Base URL', true, { placeholder: 'xxxxx.api.infobip.com' }),
      sec('api_key', 'API key'),
    ],
  },
  {
    type: 'bird', label: 'Bird (MessageBird)',
    blurb: 'Bird omnichannel messaging (SMS/WhatsApp/email). Formerly MessageBird.',
    channel: 'sms', channel_locked: false,
    defaults: capsA('webhook', 'pool'),
    credentials: [ sec('access_key', 'Access key'), txt('workspace_id', 'Workspace ID', false) ],
  },
  {
    type: 'plivo', label: 'Plivo',
    blurb: 'Plivo SMS API. Carrier-grade with transparent pricing.',
    channel: 'sms', channel_locked: true,
    defaults: capsA('webhook', 'pool'),
    credentials: [ txt('auth_id', 'Auth ID'), sec('auth_token', 'Auth token') ],
  },
  {
    type: 'telnyx', label: 'Telnyx',
    blurb: 'Telnyx SMS over its own carrier network.',
    channel: 'sms', channel_locked: true,
    defaults: capsA('webhook', 'pool'),
    credentials: [ sec('api_key', 'API key'), txt('messaging_profile_id', 'Messaging profile ID', false) ],
  },
  {
    type: 'bandwidth', label: 'Bandwidth',
    blurb: 'Bandwidth messaging over a directly-connected carrier network.',
    channel: 'sms', channel_locked: true,
    defaults: capsA('webhook', 'pool'),
    credentials: [
      txt('account_id', 'Account ID'), txt('username', 'API username'),
      sec('password', 'API password'), txt('application_id', 'Application ID', false),
    ],
  },
  {
    type: 'amazon_sns', label: 'Amazon SNS / AWS End User Messaging (SMS)',
    blurb: 'AWS SMS via SNS / End User Messaging.',
    channel: 'sms', channel_locked: true,
    // SNS exposes a per-number opt-out READ (CheckIfPhoneNumberIsOptedOut) and an
    // opt-IN write (OptInPhoneNumber), but no API to force an opt-out (recipients
    // opt out by texting STOP). No opt-out pools/lists to discover.
    defaults: {
      event_delivery: 'poll',
      can_write_optout: false, can_write_optin: true,
      can_discover_topology: false, topology_granularity: 'none',
    },
    credentials: [
      txt('access_key_id', 'AWS access key ID'), sec('secret_access_key', 'AWS secret access key'),
      txt('region', 'AWS region', true, { placeholder: 'us-west-2' }),
    ],
    notes: 'Live client (SigV4). Reconciliation works — the hub reads opt-out status via CheckIfPhoneNumberIsOptedOut and can re-opt-in via OptInPhoneNumber. It cannot force an opt-out (recipients opt out by texting STOP). Use a dedicated IAM principal scoped to SNS SMS actions only.',
  },
  {
    type: 'azure_communication', label: 'Azure Communication Services',
    blurb: 'Azure Communication Services. One resource serves SMS and email.',
    channel: 'sms', channel_locked: false,
    // Live client targets the ACS SMS Opt-Out Management API — a full read/write
    // list scoped to a sender number: check (read), add (opt-out), remove
    // (opt-in). No pools/lists to discover. Reconciliation works.
    defaults: {
      event_delivery: 'poll',
      can_write_optout: true, can_write_optin: true,
      can_discover_topology: false, topology_granularity: 'none',
    },
    credentials: [
      sec('connection_string', 'Connection string'),
      txt('from_number', 'Sender number (from)', true, { placeholder: '+18001234567' }),
    ],
    notes: 'Live client (ACS HMAC, SMS Opt-Out Management API). Opt-outs are scoped to the sender number, so set from_number. Reconciliation works — the hub checks/adds/removes opt-outs. Email is a separate ACS surface, not covered here.',
  },

  // ===== SMS · campaign / business messaging (pattern A; subscription groups)
  {
    type: 'attentive', label: 'Attentive',
    blurb: 'Attentive mobile marketing (SMS/RCS) with subscription groups.',
    channel: 'sms', channel_locked: true,
    defaults: capsA('webhook', 'group'),
    credentials: [ sec('api_key', 'API key') ],
  },
  {
    type: 'klaviyo', label: 'Klaviyo',
    blurb: 'Klaviyo omnichannel (email + SMS) with shared subscriber state.',
    channel: 'email', channel_locked: false,
    defaults: capsA('webhook', 'group'),
    credentials: [
      sec('private_api_key', 'Private API key', true, { placeholder: 'pk_xxxxxxxx' }),
      txt('public_api_key', 'Public API key (site ID)', false),
    ],
    notes: 'Email and SMS share one subscriber profile. Register one system per channel.',
  },
  {
    type: 'ez_texting', label: 'EZ Texting',
    blurb: 'EZ Texting business SMS with keyword/opt-in management.',
    channel: 'sms', channel_locked: true,
    defaults: capsA('poll', 'group'),
    credentials: [ txt('username', 'Username'), sec('api_key', 'API key') ],
  },
  {
    type: 'simpletexting', label: 'SimpleTexting',
    blurb: 'SimpleTexting business SMS and automation.',
    channel: 'sms', channel_locked: true,
    defaults: capsA('webhook', 'group'),
    credentials: [ sec('api_token', 'API token') ],
  },
  {
    type: 'slicktext', label: 'SlickText',
    blurb: 'SlickText business SMS with textword lists.',
    channel: 'sms', channel_locked: true,
    defaults: capsA('webhook', 'group'),
    credentials: [ txt('public_key', 'Public key'), sec('private_key', 'Private key') ],
  },

  // ===== SMS · withhold-only / vertical (pattern B) ==========================
  {
    type: 'mongoose_cadence', label: 'Mongoose Cadence (higher ed)',
    blurb: 'Higher-ed conversational texting. Manages STOP internally.',
    channel: 'sms', channel_locked: true,
    defaults: capsWithhold('poll'),
    credentials: [ sec('api_key', 'API key'), txt('account_id', 'Account ID', false) ],
    notes: 'Opt-out is managed in-platform; the hub ingests opt-outs by poll/export and suppresses sends.',
  },
  {
    type: 'modern_campus_message', label: 'Modern Campus Message (Signal Vine)',
    blurb: 'Higher-ed conversational texting (formerly Signal Vine).',
    channel: 'sms', channel_locked: true,
    defaults: capsWithhold('poll'),
    credentials: [ txt('token', 'API token'), sec('secret', 'API secret'), txt('account_id', 'Account ID') ],
    notes: 'Withhold-only. Auth is Modern Campus HMAC-SHA256 request signing (org-level token + secret from app.signalvine.com/sv/settings/api; each request signed over token/verb/path/body/timestamp, valid 90s). Ingest opt-outs by POLL, per program: GET /v2/programs/{id}/contacts?active=false (the `active` flag carries opt-in status). No send API, so no pre-send gate; pushing a hub opt-out back would use POST /v2/programs/{id}/participants to set a contact inactive — pending vendor confirmation that `active` is writable via upload and withholds sends. Programs/groups could later support topology discovery.',
  },

  // ===== Email · marketing / ESP (pattern A) =================================
  {
    type: 'mailchimp', label: 'Mailchimp',
    blurb: 'Mailchimp audiences/groups with unsubscribe management.',
    channel: 'email', channel_locked: true,
    defaults: capsA('webhook', 'group'),
    credentials: [
      sec('api_key', 'API key', true, { placeholder: 'xxxxxxxx-usXX' }),
      txt('server_prefix', 'Server prefix', true, { placeholder: 'us21' }),
    ],
    notes: 'Mailchimp Transactional (Mandrill) is a separate adapter type.',
  },
  {
    type: 'hubspot', label: 'HubSpot',
    blurb: 'HubSpot Marketing Email with subscription types.',
    channel: 'email', channel_locked: true,
    defaults: capsA('webhook', 'group'),
    credentials: [
      sec('access_token', 'Private-app token', true, { help: 'HubSpot private-app token (OAuth bearer).' }),
      txt('client_id', 'Client ID', false), sec('client_secret', 'Client secret', false),
      sec('refresh_token', 'Refresh token', false, { help: 'For rotating OAuth tokens; stored with its expiry.' }),
    ],
    notes: 'OAuth. Use a private-app token, or client_id/secret + refresh_token for rotating tokens.',
  },
  {
    type: 'activecampaign', label: 'ActiveCampaign',
    blurb: 'ActiveCampaign email automation with contact subscriptions.',
    channel: 'email', channel_locked: true,
    defaults: capsA('webhook', 'group'),
    credentials: [
      txt('api_url', 'API URL', true, { placeholder: 'https://you.api-us1.com' }),
      sec('api_key', 'API key'),
    ],
  },
  {
    type: 'brevo', label: 'Brevo (Sendinblue)',
    blurb: 'Brevo unified email + SMS + CRM. Formerly Sendinblue.',
    channel: 'email', channel_locked: false,
    defaults: capsA('webhook', 'group'),
    credentials: [ sec('api_key', 'API key', true, { placeholder: 'xkeysib-xxxx' }) ],
    notes: 'Email and SMS in one platform. Register one system per channel.',
  },
  {
    type: 'mailerlite', label: 'MailerLite',
    blurb: 'MailerLite email groups with unsubscribe handling.',
    channel: 'email', channel_locked: true,
    defaults: capsA('webhook', 'group'),
    credentials: [ sec('api_key', 'API key') ],
  },
  {
    type: 'mailjet', label: 'Mailjet',
    blurb: 'Mailjet email (and SMS) with contact lists.',
    channel: 'email', channel_locked: false,
    defaults: capsA('webhook', 'group'),
    credentials: [ txt('api_key', 'API key'), sec('secret_key', 'Secret key') ],
  },
  {
    type: 'salesforce_marketing_cloud', label: 'Salesforce Marketing Cloud',
    blurb: 'SFMC Engagement email with subscriber / publication lists.',
    channel: 'email', channel_locked: true,
    defaults: capsA('webhook', 'group'),
    credentials: [
      txt('subdomain', 'Auth subdomain', true, { placeholder: 'mcXXXXXXXXXX' }),
      txt('client_id', 'Client ID'), sec('client_secret', 'Client secret'),
      txt('account_id', 'Account / MID', false),
      sec('access_token', 'Access token', false), sec('refresh_token', 'Refresh token', false),
    ],
    notes: 'OAuth client-credentials. Access tokens are short-lived; store with expiry and refresh.',
  },
  {
    type: 'adobe_marketo', label: 'Adobe Marketo Engage',
    blurb: 'Marketo Engage email programs with lists/segments.',
    channel: 'email', channel_locked: true,
    defaults: capsA('poll', 'group'),
    credentials: [
      txt('munchkin_id', 'Munchkin / instance', true, { placeholder: '123-ABC-456' }),
      txt('client_id', 'Client ID'), sec('client_secret', 'Client secret'),
    ],
    notes: 'REST API with OAuth client-credentials.',
  },
  {
    type: 'dynamics_journeys', label: 'Dynamics 365 Customer Insights – Journeys',
    blurb: 'Native marketing email for Dynamics 365 (via Dataverse).',
    channel: 'email', channel_locked: true,
    defaults: capsA('webhook', 'group'),
    credentials: [
      txt('tenant_id', 'Azure AD tenant ID'), txt('client_id', 'Client ID'),
      sec('client_secret', 'Client secret'),
      txt('org_url', 'Dataverse org URL', true, { placeholder: 'https://org.crm.dynamics.com' }),
    ],
    notes: 'Azure AD app registration. Native fit for a Dynamics 365 CRM stack.',
  },

  // ===== Email · transactional / SMTP API (pattern A; webhook event stream) ==
  {
    type: 'sendgrid', label: 'Twilio SendGrid',
    blurb: 'SendGrid email with suppression groups and an event webhook.',
    channel: 'email', channel_locked: true,
    defaults: capsA('webhook', 'group'),
    credentials: [
      sec('api_key', 'API key', true, { placeholder: 'SG.xxxxxxxx' }),
      sec('event_webhook_key', 'Event Webhook verification key', false, {
        help: 'Base64 ECDSA (P-256) verification key from SendGrid → Signed Event Webhook. Required to receive inbound opt-out events at /api/webhooks/sendgrid/<system>.',
      }),
    ],
  },
  {
    type: 'amazon_ses', label: 'Amazon SES',
    blurb: 'Amazon SES with an account-level suppression list and event destinations.',
    channel: 'email', channel_locked: true,
    // SESv2 account-level suppression list is a full read/write surface: read a
    // number's status, add (opt-out), and remove (opt-in). No list/group
    // structure to discover. Reconciliation works (observe reads the list).
    defaults: {
      event_delivery: 'poll',
      can_write_optout: true, can_write_optin: true,
      can_discover_topology: false, topology_granularity: 'none',
    },
    credentials: [
      txt('access_key_id', 'AWS access key ID'), sec('secret_access_key', 'AWS secret access key'),
      txt('region', 'AWS region', true, { placeholder: 'us-west-2' }),
      txt('configuration_set', 'Configuration set', false),
    ],
    notes: 'Live client (SigV4, SESv2). Reconciliation works — the hub reads suppression status, adds an address on opt-out (Reason COMPLAINT), and removes it on opt-in. No pools/lists to discover.',
  },
  {
    type: 'mailgun', label: 'Mailgun',
    blurb: 'Mailgun transactional email with suppressions and mailing lists. Owned by Sinch.',
    channel: 'email', channel_locked: true,
    defaults: capsA('webhook', 'group'),
    credentials: [
      sec('api_key', 'API key'), txt('domain', 'Sending domain', true, { placeholder: 'mg.example.com' }),
      txt('region', 'Region', false, { placeholder: 'us | eu' }),
    ],
  },
  {
    type: 'postmark', label: 'Postmark',
    blurb: 'Postmark transactional email with message streams and subscription webhooks.',
    channel: 'email', channel_locked: true,
    defaults: capsA('webhook', 'group'),
    credentials: [ sec('server_token', 'Server token'), sec('account_token', 'Account token', false) ],
    notes: 'From ActiveCampaign. Subscription-management webhooks carry unsubscribe events.',
  },
  {
    type: 'mailchimp_transactional', label: 'Mailchimp Transactional (Mandrill)',
    blurb: 'Mandrill transactional email with an account-level reject/allow list.',
    channel: 'email', channel_locked: true,
    defaults: capsA('webhook', 'none', { can_write_optin: false, can_discover_topology: false }),
    credentials: [ sec('api_key', 'Mandrill API key') ],
    notes: 'Requires a paid Mailchimp account. No list/group structure to discover.',
  },
];

export function getAdapterTypeSpec(type: string): AdapterTypeSpec | undefined {
  return ADAPTER_CATALOG.find((a) => a.type === type);
}

export function isAdapterType(type: string): type is AdapterType {
  return (ADAPTER_TYPES as readonly string[]).includes(type);
}

/** Keys of credentials marked required for a type (used by the connection test). */
export function requiredCredentialKeys(type: string): string[] {
  return getAdapterTypeSpec(type)?.credentials.filter((c) => c.required).map((c) => c.key) ?? [];
}

/** Whether a credential key is defined for a type (rejects unknown keys on write). */
export function isKnownCredentialKey(type: string, key: string): boolean {
  return getAdapterTypeSpec(type)?.credentials.some((c) => c.key === key) ?? false;
}
