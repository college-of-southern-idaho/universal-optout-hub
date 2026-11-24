import { pool } from '../db.js';
import type { SystemRow } from '../core/types.js';
import type { Adapter } from './contract.js';
import { MockAdapter } from './mock.js';
import { SendGridAdapter } from './sendgrid.js';
import { TwilioAdapter } from './twilio.js';
import { ConstantContactAdapter } from './constant_contact.js';
import { TelesignAdapter } from './telesign.js';
import { AmazonSnsAdapter } from './amazon_sns.js';
import { AmazonSesAdapter } from './amazon_ses.js';
import { AzureCommunicationAdapter } from './azure_communication.js';
import { SignalVineAdapter } from './signal_vine.js';
import { getDecryptedCredentials } from './credential-store.js';
import { requiredCredentialKeys } from './catalog.js';

/**
 * Adapter registry. Builds one adapter per active system, dispatching on
 * adapter_type. A type with no real client — or one whose required credentials
 * are not yet set — falls back to MockAdapter, so every system stays demoable
 * until it is fully configured. Once the credentials are present (and the
 * registry reloaded), the live client takes over.
 */

type AdapterFactory = (row: SystemRow, creds: Record<string, string>) => Adapter;

// Real clients by adapter_type. Everything else uses the mock.
const ADAPTER_FACTORIES: Record<string, AdapterFactory> = {
  sendgrid: (row, creds) => new SendGridAdapter(row, creds),
  twilio: (row, creds) => new TwilioAdapter(row, creds),
  constant_contact: (row, creds) => new ConstantContactAdapter(row, creds),
  telesign: (row, creds) => new TelesignAdapter(row, creds),
  amazon_sns: (row, creds) => new AmazonSnsAdapter(row, creds),
  amazon_ses: (row, creds) => new AmazonSesAdapter(row, creds),
  azure_communication: (row, creds) => new AzureCommunicationAdapter(row, creds),
  modern_campus_message: (row, creds) => new SignalVineAdapter(row, creds),
};

async function buildAdapter(row: SystemRow): Promise<Adapter> {
  const factory = ADAPTER_FACTORIES[row.adapter_type];
  if (!factory) return new MockAdapter(row);
  try {
    const creds = await getDecryptedCredentials(row.id);
    const missing = requiredCredentialKeys(row.adapter_type).filter((k) => !creds[k]);
    if (missing.length) return new MockAdapter(row);     // not configured yet → stay on mock
    return factory(row, creds);
  } catch (e: any) {
    console.warn(`adapter ${row.id} (${row.adapter_type}) failed to build; using mock: ${e.message}`);
    return new MockAdapter(row);
  }
}

const registry = new Map<string, Adapter>();

export async function loadAdapters(): Promise<Map<string, Adapter>> {
  // Archived systems are excluded: they keep their consent history but are no
  // longer used for sends, discovery, or reconciliation.
  const r = await pool.query<SystemRow>('SELECT * FROM systems WHERE archived_at IS NULL ORDER BY id');
  registry.clear();
  for (const row of r.rows) registry.set(row.id, await buildAdapter(row));
  return registry;
}

export function getAdapter(systemId: string): Adapter {
  const a = registry.get(systemId);
  if (!a) throw new Error(`no adapter registered for system ${systemId}`);
  return a;
}

export function allAdapters(): Adapter[] {
  return [...registry.values()];
}

/** Adapter types with a real (non-mock) client implemented. */
export function liveAdapterTypes(): string[] {
  return Object.keys(ADAPTER_FACTORIES);
}
