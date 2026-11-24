import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4 signing for the query/POST APIs (e.g. Amazon SNS),
 * hand-rolled on node:crypto — no AWS SDK dependency, matching the repo's
 * zero-exotic-deps posture. Only the pieces the SNS adapter needs: a POST to `/`
 * with an x-www-form-urlencoded body and the three standard signed headers.
 *
 * The signing-key derivation is verified in tests against AWS's published
 * example vector (docs: "Deriving the signing key").
 */

function sha256hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** Derive the SigV4 signing key (kSigning) via the HMAC chain. Pure. */
export function deriveSigningKey(
  secretKey: string, dateStamp: string, region: string, service: string,
): Buffer {
  const kDate = hmac('AWS4' + secretKey, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

export interface SignInput {
  method: string;            // 'GET' | 'POST' | 'PUT' | 'DELETE' …
  host: string;              // e.g. 'sns.us-west-2.amazonaws.com'
  region: string;
  service: string;           // e.g. 'sns', 'ses'
  body: string;              // request body ('' for GET/DELETE)
  accessKeyId: string;
  secretAccessKey: string;
  amzDate: string;           // 'YYYYMMDDTHHMMSSZ'
  path?: string;             // canonical URI, default '/'
  query?: string;            // canonical query string (sorted), default ''
  headers?: Record<string, string>; // extra headers to sign (e.g. content-type); host + x-amz-date are always signed
}

/**
 * Pure: compute the SigV4 Authorization header. host and x-amz-date are always
 * signed; callers add content-type (and any other header) via `headers` — those
 * MUST match what the request actually sends. Returns the header value + the
 * signed-headers list.
 */
export function signAwsV4(inp: SignInput): { authorization: string; signedHeaders: string; signature: string } {
  const path = inp.path ?? '/';
  const query = inp.query ?? '';
  const dateStamp = inp.amzDate.slice(0, 8);

  const hdrs: Record<string, string> = { host: inp.host, 'x-amz-date': inp.amzDate };
  for (const [k, v] of Object.entries(inp.headers ?? {})) hdrs[k.toLowerCase()] = v;
  const names = Object.keys(hdrs).sort();
  const canonicalHeaders = names.map((n) => `${n}:${hdrs[n].trim()}\n`).join('');
  const signedHeaders = names.join(';');

  const canonicalRequest = [
    inp.method, path, query, canonicalHeaders, signedHeaders, sha256hex(inp.body),
  ].join('\n');

  const scope = `${dateStamp}/${inp.region}/${inp.service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256', inp.amzDate, scope, sha256hex(canonicalRequest),
  ].join('\n');

  const signingKey = deriveSigningKey(inp.secretAccessKey, dateStamp, inp.region, inp.service);
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${inp.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { authorization, signedHeaders, signature };
}

/** Current time as an AWS `amz-date` (YYYYMMDDTHHMMSSZ). */
export function amzDateNow(now: Date = new Date()): string {
  return now.toISOString().replace(/[:-]/g, '').replace(/\.\d{3}/, '');
}
