export type Channel = 'sms' | 'email';
export type Direction = 'opt_in' | 'opt_out';
export type Provenance = 'explicit' | 'derived';
export type State = 'unknown' | 'opted_in' | 'opted_out' | 'suppressed';

export interface ConsentEvent {
  id: number;
  identity_id: number;
  system_id: string;
  channel: Channel;
  direction: Direction;
  provenance: Provenance;
  occurred_at: Date;
  source_detail: string | null;
}

export interface FoldedState {
  state: State;
  provenance: Provenance | null;
  as_of_event: number | null;
}

export interface SystemRow {
  id: string;
  name: string;
  channel: Channel;
  // Consent-relevant classification, alongside `channel` (NOT topology): drives
  // which services an opt-out cascades to, via the category matrix (DESIGN.md
  // §10). FK to consent_categories.key; defaults to 'marketing' (migration 016).
  category: string;
  event_delivery: string;
  can_write_optout: boolean;
  can_write_optin: boolean;
  vendor_suppression: string | null;
  // Service-discovered topology capability (ADR-0002 §2.3, DESIGN.md §9).
  can_discover_topology: boolean;
  topology_granularity: TopologyGranularity;
  // Service configuration (migration 005). Operational only — never read by a
  // consent decision. adapter_type selects the client; the rest is phase-1
  // connection lifecycle for the admin list.
  adapter_type: string;
  connection_status: 'draft' | 'connected' | 'error';
  last_test_at: Date | null;
  last_test_detail: string | null;
  created_at: Date;
  archived_at: Date | null;   // soft delete: non-null = archived (excluded from registry)
}

/** Stored-credential metadata. The secret itself is never returned. */
export interface CredentialMeta {
  cred_key: string;
  last4: string | null;
  updated_at: Date;
  updated_by: string | null;
  expires_at: Date | null;   // OAuth access-token expiry, if any
}

// --- Service-discovered topology (ADR-0002) ---------------------------------
// Reporting/attribution metadata only. Consent decisions never read these.

export type TopologyKind = 'pool' | 'group' | 'code';
export type TopologyGranularity = 'none' | 'code' | 'pool' | 'group';

export interface TopologyNode {
  id: number;
  system_id: string;
  kind: TopologyKind;
  external_ref: string;
  label: string | null;
  parent_ref: string | null;
  source: string;                  // service id (discovered) | 'none'
  last_seen_at: Date;
  decommissioned_at: Date | null;
}

/** A node as a service reports it, before it is persisted as a TopologyNode. */
export interface DiscoveredNode {
  kind: TopologyKind;
  external_ref: string;
  label: string | null;
  parent_ref: string | null;
}

export interface CodeAnnotation {
  id: number;
  system_id: string;
  code_ref: string;
  label: string;
  source: 'manual';
  actor: string | null;
  created_at: Date;
}
