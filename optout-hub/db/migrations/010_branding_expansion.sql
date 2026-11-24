-- 010_branding_expansion.sql — expand per-deployment branding (roadmap item 10):
-- a fuller color palette, a favicon, and a browser-tab title. Additive columns
-- on the single app_branding row. Idempotent; rerun-safe.

ALTER TABLE app_branding ADD COLUMN IF NOT EXISTS header_color     TEXT;  -- header bar (#rrggbb)
ALTER TABLE app_branding ADD COLUMN IF NOT EXISTS text_color       TEXT;  -- body text (#rrggbb)
ALTER TABLE app_branding ADD COLUMN IF NOT EXISTS card_color       TEXT;  -- card surfaces (#rrggbb)
ALTER TABLE app_branding ADD COLUMN IF NOT EXISTS optin_color      TEXT;  -- opt-in status (#rrggbb)
ALTER TABLE app_branding ADD COLUMN IF NOT EXISTS optout_color     TEXT;  -- opt-out status (#rrggbb)
ALTER TABLE app_branding ADD COLUMN IF NOT EXISTS suppressed_color TEXT;  -- suppressed status (#rrggbb)
ALTER TABLE app_branding ADD COLUMN IF NOT EXISTS favicon_data     TEXT;  -- data: URL or https URL
ALTER TABLE app_branding ADD COLUMN IF NOT EXISTS browser_title    TEXT;  -- <title> / tab text
