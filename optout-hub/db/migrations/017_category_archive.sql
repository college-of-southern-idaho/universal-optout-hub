-- 017_category_archive.sql — soft-delete for message categories (DESIGN.md §10).
-- A category can be hard-DELETED only when no service (active or archived) uses
-- it; otherwise it is ARCHIVED — retired from new assignment but still honored
-- for the services already on it (mirrors the systems archive/delete lifecycle).
-- Additive, idempotent.
ALTER TABLE consent_categories ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
