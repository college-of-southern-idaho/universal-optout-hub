import { pool } from '../src/db.js';

/**
 * The demo/seed platform set, shared by `npm run seed` and `npm run demo` so the
 * two never drift. Capability differences are deliberate:
 *  - twilio_custom models Twilio's vendor-level STOP handling: the hub can write
 *    opt-outs, but opt-ins require consumer action (START), so can_write_optin is
 *    false → approved propagations raise alerts instead.
 *  - sms_gateway is an email-to-SMS gateway: transport is email, but its consent
 *    channel is SMS (DESIGN.md §9).
 */
export const DEMO_SYSTEMS = [
  {
    id: 'anthology_reach',
    name: 'Anthology Reach (Telesign)',
    channel: 'sms',
    event_delivery: 'webhook',
    can_write_optout: true,
    can_write_optin: true,
    vendor_suppression: 'Telesign-level suppression list',
    can_discover_topology: false,
    topology_granularity: 'none',
  },
  {
    id: 'twilio_custom',
    name: 'Custom texting (Twilio)',
    channel: 'sms',
    event_delivery: 'webhook',
    can_write_optout: true,
    can_write_optin: false,
    vendor_suppression: 'Twilio built-in STOP handling; START required to reverse',
    can_discover_topology: true,
    topology_granularity: 'pool',
  },
  {
    id: 'constant_contact',
    name: 'Constant Contact',
    channel: 'email',
    event_delivery: 'export',
    can_write_optout: true,
    can_write_optin: true,
    vendor_suppression: null,
    can_discover_topology: true,
    topology_granularity: 'pool',
  },
  {
    id: 'sms_gateway',
    name: 'Email-to-SMS gateway',
    channel: 'sms', // consent classification, not transport!
    event_delivery: 'poll',
    can_write_optout: true,
    can_write_optin: true,
    vendor_suppression: null,
    can_discover_topology: false,
    topology_granularity: 'none',
  },
];

/**
 * Upsert the demo systems and ensure they are ACTIVE. The `archived_at=NULL`
 * reset matters: interactive use of the console can archive or delete these, and
 * `loadAdapters()` only registers active systems — so without this, a later
 * `npm run demo` would fail with "no adapter registered". Idempotent.
 */
export async function ensureDemoSystems(): Promise<void> {
  for (const s of DEMO_SYSTEMS) {
    await pool.query(
      `INSERT INTO systems (id, name, channel, event_delivery, can_write_optout,
         can_write_optin, vendor_suppression, can_discover_topology, topology_granularity)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET name=$2, channel=$3, event_delivery=$4,
         can_write_optout=$5, can_write_optin=$6, vendor_suppression=$7,
         can_discover_topology=$8, topology_granularity=$9, archived_at=NULL`,
      [s.id, s.name, s.channel, s.event_delivery, s.can_write_optout, s.can_write_optin,
       s.vendor_suppression, s.can_discover_topology, s.topology_granularity],
    );
  }
}
