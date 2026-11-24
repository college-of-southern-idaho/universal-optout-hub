-- 008_branding.sql — subtle per-deployment UI branding (logo + colors + name).
-- A single settings row (id is pinned to 1). Idempotent: the runner reapplies
-- every migration on each boot.

CREATE TABLE IF NOT EXISTS app_branding (
  id            INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  org_name      TEXT,
  logo_data     TEXT,          -- data: URL (uploaded) or an https URL
  accent_color  TEXT,          -- #rrggbb
  bg_color      TEXT,          -- #rrggbb
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    TEXT
);

INSERT INTO app_branding (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
