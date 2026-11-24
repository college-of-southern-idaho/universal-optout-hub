-- Expand the service catalog (DESIGN.md §9) to cover the broad set of
-- reputable SMS and email senders, not just the higher-ed set. Purely additive
-- and idempotent (the runner reapplies every migration each run).
--
-- 1. Widen systems.adapter_type to the full catalog. The IN-list is generated
--    from src/adapters/catalog.ts ADAPTER_TYPES, so SQL and code stay in sync.
--    Drop-then-add keeps this rerun-safe.
ALTER TABLE systems DROP CONSTRAINT IF EXISTS systems_adapter_type_check;
ALTER TABLE systems ADD CONSTRAINT systems_adapter_type_check
  CHECK (adapter_type IN ('mock', 'twilio', 'telesign', 'constant_contact', 'email_sms_gateway', 'vonage', 'sinch', 'infobip', 'bird', 'plivo', 'telnyx', 'bandwidth', 'amazon_sns', 'azure_communication', 'attentive', 'klaviyo', 'ez_texting', 'simpletexting', 'slicktext', 'mongoose_cadence', 'modern_campus_message', 'mailchimp', 'hubspot', 'activecampaign', 'brevo', 'mailerlite', 'mailjet', 'salesforce_marketing_cloud', 'adobe_marketo', 'dynamics_journeys', 'sendgrid', 'amazon_ses', 'mailgun', 'postmark', 'mailchimp_transactional'));

-- 2. OAuth support: access tokens are short-lived, so a credential row may carry
--    an expiry. expires_at is non-sensitive metadata (the token stays encrypted
--    in secret_enc and is never read back through the API). NULL for the common
--    static-key/secret credentials.
ALTER TABLE system_credentials ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
