-- ADR-0002: service-discovered topology (reporting/attribution ONLY).
--
-- Topology labels which pool/department a code or event belongs to, for
-- reporting and operational visibility. It is NEVER read by consent decisions
-- (precedence, opt-out propagation, the approval gate). That firewall is
-- absolute (ADR-0002 §2.2): no consent query in this codebase joins these
-- tables, and topology.ts carries no path that writes a consent_event.
--
-- This migration is purely additive. The superseded ADR-0001 group-pooling
-- model (a hand-set codes.group_id driving automatic opt-in propagation across
-- sibling codes) was never present on this line of development, so there is
-- nothing to drop.

-- Per-adapter discovery capability (ADR-0002 §2.3; DESIGN.md §9). Whether a
-- system can discover its own topology from the service, and at what
-- granularity. Services that cannot report groupings stay 'none' and rely on
-- the manual annotation layer below.
ALTER TABLE systems
  ADD COLUMN IF NOT EXISTS can_discover_topology BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE systems
  ADD COLUMN IF NOT EXISTS topology_granularity TEXT NOT NULL DEFAULT 'none'
    CHECK (topology_granularity IN ('none', 'code', 'pool', 'group'));

-- Discovered topology nodes (ADR-0002 §4). One row per pool/group/code as the
-- service reports it. `source` is provenance: the service id for discovered
-- facts, 'none' where the service cannot report structure. Nodes are never
-- hard-deleted; a node the service stops reporting is soft-decommissioned so
-- historical attribution still resolves.
CREATE TABLE IF NOT EXISTS topology_nodes (
  id                SERIAL PRIMARY KEY,
  system_id         TEXT NOT NULL REFERENCES systems(id),
  kind              TEXT NOT NULL CHECK (kind IN ('pool', 'group', 'code')),
  external_ref      TEXT NOT NULL,            -- the service's own id for the node
  label             TEXT,                     -- human label from the service, if any
  parent_ref        TEXT,                     -- external_ref of the parent node, if any
  source            TEXT NOT NULL,            -- '<service id>' (discovered) | 'none'
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  decommissioned_at TIMESTAMPTZ,              -- soft delete when the service drops it
  UNIQUE (system_id, kind, external_ref)
);
CREATE INDEX IF NOT EXISTS topology_nodes_system ON topology_nodes (system_id);
CREATE INDEX IF NOT EXISTS topology_nodes_parent ON topology_nodes (system_id, parent_ref);

-- Manual grouping annotations (ADR-0002 §2.4). Kept SEPARATE from discovered
-- facts: source is always 'manual'. The discovery sync never touches this
-- table, and these rows never masquerade as discovered facts. Where discovery
-- and a manual annotation disagree, reporting shows BOTH rather than letting
-- either silently overwrite the other -- the same explicit/derived provenance
-- discipline the consent model uses.
CREATE TABLE IF NOT EXISTS code_annotations (
  id            SERIAL PRIMARY KEY,
  system_id     TEXT NOT NULL REFERENCES systems(id),
  code_ref      TEXT NOT NULL,               -- external_ref of the annotated code
  label         TEXT NOT NULL,               -- operator-assigned grouping label
  source        TEXT NOT NULL DEFAULT 'manual' CHECK (source = 'manual'),
  actor         TEXT,
  actor_user_id INT REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (system_id, code_ref)
);

-- Event attribution (ADR-0002 §4): the receiving code an inbound event landed
-- on. Reporting joins through topology to the pool/department. Nullable --
-- not every service reports a receiving code (§6 verification item), and this
-- is attribution metadata only, never consulted by consent logic.
ALTER TABLE consent_events
  ADD COLUMN IF NOT EXISTS receiving_code TEXT;
CREATE INDEX IF NOT EXISTS consent_events_receiving_code
  ON consent_events (system_id, receiving_code) WHERE receiving_code IS NOT NULL;

-- Simulated service-reported topology. The mock adapter "discovers" from this
-- table, exactly as platform_records simulates an external suppression list.
-- In production this table does not exist; adapters call the real service API.
CREATE TABLE IF NOT EXISTS platform_topology (
  system_id    TEXT NOT NULL REFERENCES systems(id),
  kind         TEXT NOT NULL CHECK (kind IN ('pool', 'group', 'code')),
  external_ref TEXT NOT NULL,
  label        TEXT,
  parent_ref   TEXT,
  PRIMARY KEY (system_id, kind, external_ref)
);
