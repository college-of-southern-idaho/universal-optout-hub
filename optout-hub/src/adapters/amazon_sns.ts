import { signAwsV4, amzDateNow } from './awssig.js';
import type { Adapter, WriteResult } from './contract.js';
import type { Direction, DiscoveredNode, SystemRow } from '../core/types.js';

/**
 * Amazon SNS SMS adapter — a live client for AWS's SMS opt-out surface.
 *
 * SNS's capability profile is the mirror image of Twilio's:
 *   - probe            → ListPhoneNumbersOptedOut (authenticate)
 *   - observe          → CheckIfPhoneNumberIsOptedOut — SNS DOES expose a
 *                        per-number opt-out read, so reconciliation works here.
 *   - write(opt_in)    → OptInPhoneNumber (re-enable a number that opted out)
 *   - write(opt_out)   → UNSUPPORTED: there is no API to force an opt-out; a
 *                        recipient opts out by texting STOP. Enforce by
 *                        withholding sends.
 *   - discoverTopology → none (SMS opt-out has no pools/lists)
 *
 * SNS uses the AWS query API (POST form body, XML response) signed with SigV4
 * (see awssig.ts). Endpoint: sns.<region>.amazonaws.com, API version 2010-03-31.
 */
export class AmazonSnsAdapter implements Adapter {
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  private readonly region: string;
  private readonly service = 'sns';
  private readonly version = '2010-03-31';

  constructor(public readonly system: SystemRow, creds: Record<string, string>) {
    this.accessKeyId = creds.access_key_id ?? '';
    this.secretAccessKey = creds.secret_access_key ?? '';
    this.region = creds.region ?? '';
  }

  get canDiscoverTopology(): boolean {
    return false;
  }

  private get host(): string {
    return `sns.${this.region}.amazonaws.com`;
  }

  /** Sign and POST one SNS query action; returns status + raw XML. */
  private async call(action: string, params: Record<string, string> = {}): Promise<{ status: number; ok: boolean; xml: string }> {
    const body = new URLSearchParams({ Action: action, Version: this.version, ...params }).toString();
    const amzDate = amzDateNow();
    const { authorization } = signAwsV4({
      method: 'POST', host: this.host, region: this.region, service: this.service,
      body, accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey, amzDate,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const res = await fetch(`https://${this.host}/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Amz-Date': amzDate,
        Authorization: authorization,
      },
      body,
    });
    return { status: res.status, ok: res.ok, xml: await res.text() };
  }

  async probe(): Promise<{ ok: boolean; detail: string }> {
    if (!this.accessKeyId || !this.secretAccessKey || !this.region) {
      return { ok: false, detail: 'access_key_id, secret_access_key and region are required' };
    }
    try {
      const r = await this.call('ListPhoneNumbersOptedOut');
      if (r.ok) return { ok: true, detail: `authenticated to SNS in ${this.region}` };
      if (r.status === 403) return { ok: false, detail: 'access denied — check the IAM keys/permissions (403)' };
      return { ok: false, detail: awsError(r.xml) ?? `SNS returned ${r.status}` };
    } catch (e: any) {
      return { ok: false, detail: `unreachable: ${e.message}` };
    }
  }

  async observe(phone: string): Promise<'opted_in' | 'opted_out' | 'none'> {
    const r = await this.call('CheckIfPhoneNumberIsOptedOut', { PhoneNumber: phone });
    if (!r.ok) return 'none'; // can't determine → unknown
    // SNS only reports opted-out yes/no; "not opted out" is not a positive opt-in.
    return parseIsOptedOut(r.xml) ? 'opted_out' : 'none';
  }

  async write(phone: string, direction: Direction, syncOriginKey: string): Promise<WriteResult> {
    void syncOriginKey;
    const cap = direction === 'opt_out' ? this.system.can_write_optout : this.system.can_write_optin;
    if (!cap) {
      return { ok: false, reason: `system ${this.system.id} does not accept hub ${direction} writes` };
    }
    if (direction === 'opt_out') {
      return {
        ok: false,
        reason: 'SNS has no API to force an opt-out (a recipient opts out by texting STOP); enforce opt-out by withholding sends',
      };
    }
    // opt_in → OptInPhoneNumber. AWS only allows opting a number back in once per
    // 30 days; a rejection comes back as an error we surface.
    const r = await this.call('OptInPhoneNumber', { PhoneNumber: phone });
    if (r.ok) return { ok: true };
    return { ok: false, reason: awsError(r.xml) ?? `SNS OptInPhoneNumber returned ${r.status}` };
  }

  async consumerAction(): Promise<void> {
    throw new Error('consumerAction is not supported on a live Amazon SNS adapter');
  }

  async discoverTopology(): Promise<DiscoveredNode[]> {
    return [];
  }
}

/** Pure: read `<isOptedOut>` from a CheckIfPhoneNumberIsOptedOut response. */
export function parseIsOptedOut(xml: string): boolean {
  return /<isOptedOut>\s*true\s*<\/isOptedOut>/i.test(xml);
}

/** Pure: pull an AWS `<Error><Code>/<Message>` into a readable string, or null. */
export function awsError(xml: string): string | null {
  const code = /<Code>([^<]+)<\/Code>/.exec(xml)?.[1];
  const message = /<Message>([^<]+)<\/Message>/.exec(xml)?.[1];
  if (!code && !message) return null;
  return [code, message].filter(Boolean).join(': ');
}
