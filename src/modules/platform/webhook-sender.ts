import { createHmac } from 'crypto';
import { promises as dns } from 'dns';
import { isIP } from 'net';

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_CHARS = 2000;

export interface SendResult {
  statusCode: number | null;
  success: boolean;
  durationMs: number;
  responseBody: string;
}

/** Private, loopback, link-local and CGNAT ranges (IPv4 and IPv6). */
export function isPrivateAddress(ip: string): boolean {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  return (
    v6 === '::1' ||
    v6 === '::' ||
    v6.startsWith('fc') ||
    v6.startsWith('fd') ||
    v6.startsWith('fe8') ||
    v6.startsWith('fe9') ||
    v6.startsWith('fea') ||
    v6.startsWith('feb')
  );
}

/**
 * Refuses URLs that resolve to internal addresses, so webhook tests cannot be used
 * to reach services inside the server's network. Development allows localhost,
 * because testing a webhook against a local receiver is the normal workflow.
 */
async function assertPublicTarget(url: URL) {
  if (process.env.NODE_ENV !== 'production') return;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host)
    ? [host]
    : (await dns.lookup(host, { all: true })).map((a) => a.address);
  if (!addresses.length || addresses.some(isPrivateAddress)) {
    throw new Error('Webhook URLs must resolve to a public address');
  }
}

/**
 * Signature header: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>" with the endpoint secret>`.
 * Receivers recompute it and reject requests older than a few minutes.
 */
export function signature(secret: string, body: string, timestamp: number) {
  const mac = createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  return `t=${timestamp},v1=${mac}`;
}

export async function sendWebhook(
  rawUrl: string,
  secret: string,
  event: string,
  body: string,
): Promise<SendResult> {
  const started = Date.now();
  try {
    const url = new URL(rawUrl);
    await assertPublicTarget(url);
    const timestamp = Math.floor(Date.now() / 1000);
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'content-type': 'application/json',
        'user-agent': 'LinqFlow-Webhooks/1.0',
        'x-linqflow-event': event,
        'x-linqflow-signature': signature(secret, body, timestamp),
      },
      body,
    });
    const responseBody = (await response.text()).slice(0, MAX_RESPONSE_CHARS);
    return {
      statusCode: response.status,
      success: response.status >= 200 && response.status < 300,
      durationMs: Date.now() - started,
      responseBody,
    };
  } catch (error) {
    const reason =
      error instanceof Error
        ? error.name === 'TimeoutError'
          ? `Timed out after ${TIMEOUT_MS / 1000}s`
          : error.message
        : 'Request failed';
    return {
      statusCode: null,
      success: false,
      durationMs: Date.now() - started,
      responseBody: reason.slice(0, MAX_RESPONSE_CHARS),
    };
  }
}
