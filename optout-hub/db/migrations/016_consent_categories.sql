-- 016_consent_categories.sql — message categories + the opt-out cascade matrix.
-- Replaces the single 'optOutPropagation' scope knob with a data-driven category
-- model (DESIGN.md §10). Each service is tagged with a category; an opt-out
-- cascades from its source category to target categories per the matrix below.
-- Categories flagged `protected` (e.g. emergency/safety) NEVER receive a
-- suppression — the engine enforces that regardless of matrix rows, so emergency
-- notices stay deliverable (47 C.F.R. 64.1200(f)(4)). Additive, idempotent.

CREATE TABLE IF NOT EXISTS consent_categories (
  key        TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  protected  BOOLEAN NOT NULL DEFAULT false,   -- true = never suppressed (e.g. emergency)
  sort_order INT NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed the legally-grounded starter set (DESIGN.md §2, federal research).
-- Admins can add more; the engine reads the table, not a hardcoded enum.
INSERT INTO consent_categories (key, label, protected, sort_order) VALUES
  ('marketing',     'Marketing / promotional',       false, 10),
  ('transactional', 'Transactional / informational', false, 20),
  ('emergency',     'Emergency / safety',            true,  30)
ON CONFLICT (key) DO NOTHING;

-- Per-service category. A consent-relevant classification (like channel), NOT
-- topology. Defaults to 'marketing' so existing services preserve today's
-- cascade behavior until an admin reclassifies them (seed is created above, so
-- the default value satisfies the FK).
ALTER TABLE systems ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'marketing'
  REFERENCES consent_categories(key);

-- Cascade matrix. Presence of (source, target) means an opt-out on a
-- source-category service suppresses target-category services. A protected
-- target is never inserted here and is ignored by the engine even if present.
CREATE TABLE IF NOT EXISTS consent_category_cascade (
  source TEXT NOT NULL REFERENCES consent_categories(key) ON DELETE CASCADE,
  target TEXT NOT NULL REFERENCES consent_categories(key) ON DELETE CASCADE,
  PRIMARY KEY (source, target)
);

-- Default matrix: each category cascades to itself, plus transactional ->
-- marketing (a student rejecting essential info almost certainly rejects promos
-- too). Emergency is protected: never a target, and has no opt-out to cascade.
INSERT INTO consent_category_cascade (source, target) VALUES
  ('marketing',     'marketing'),
  ('transactional', 'transactional'),
  ('transactional', 'marketing')
ON CONFLICT DO NOTHING;
