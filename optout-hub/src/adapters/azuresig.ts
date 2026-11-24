import { createHash, createHmac } from 'node:crypto';

/**
 * Azure Communication Services HMAC-SHA256 request signing (the scheme ACS uses
 * across its data-plane APIs, e.g. SMS opt-out management). Hand-rolled on
 * node:crypto — no Azure SDK dependency. Verified against Microsoft's documented
 * signing steps (opt-out-api-quickstart).
 *
 *   stringToSign = VERB "\n" pathAndQuery "\n" x-ms-date ";" host ";" contentHash
 *   signature    = base64( HMAC-SHA256( base64decode(accessKey), stringToSign ) )
 *   contentHash  = base64( SHA-256( body ) )
 */

/** base64(SHA-256(body)) — the value for the x-ms-content-sha256 header. */
export function acsContentHash(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('base64');
}

export interface AcsSignInput {
  method: string;         // 'POST'
  pathAndQuery: string;   // e.g. '/sms/optouts:add?api-version=2026-01-23'
  host: string;           // e.g. 'my-resource.communication.azure.com'
  body: string;
  accessKey: string;      // the base64 access key from the connection string
  date: string;           // RFC1123 GMT, e.g. new Date().toUTCString()
}

/** Pure: the Authorization header value + the content hash to send. */
export function acsSign(inp: AcsSignInput): { authorization: string; contentHash: string } {
  const contentHash = acsContentHash(inp.body);
  const stringToSign = `${inp.method}\n${inp.pathAndQuery}\n${inp.date};${inp.host};${contentHash}`;
  const signature = createHmac('sha256', Buffer.from(inp.accessKey, 'base64'))
    .update(stringToSign, 'utf8').digest('base64');
  return {
    authorization: `HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${signature}`,
    contentHash,
  };
}

/** RFC1123 GMT date for 'now' (the x-ms-date header format). */
export function rfc1123Now(now: Date = new Date()): string {
  return now.toUTCString();
}

/** Parse `endpoint` + `accesskey` from an ACS connection string. */
export function parseAcsConnectionString(cs: string): { endpoint: string; accessKey: string } | null {
  const parts: Record<string, string> = {};
  for (const kv of cs.split(';')) {
    const i = kv.indexOf('=');
    if (i > 0) parts[kv.slice(0, i).trim().toLowerCase()] = kv.slice(i + 1).trim();
  }
  const endpoint = parts.endpoint?.replace(/\/+$/, '');
  const accessKey = parts.accesskey;
  if (!endpoint || !accessKey) return null;
  return { endpoint, accessKey };
}
