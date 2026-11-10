import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Unsubscribe links: `<tenantId>.<contactId>.<sig>`, HMAC-SHA256 over both ids.
 * No expiry (links in old emails must keep working); not guessable without the key.
 */
function signingKey() {
  return (
    process.env.SECRETS_ENCRYPTION_KEY ||
    `linqflow-dev-unsubscribe:${process.env.JWT_SECRET ?? ''}`
  );
}

const sig = (tenantId: string, contactId: string) =>
  createHmac('sha256', signingKey())
    .update(`unsubscribe:${tenantId}:${contactId}`)
    .digest('base64url')
    .slice(0, 32);

export function unsubscribeToken(tenantId: string, contactId: string) {
  return `${tenantId}.${contactId}.${sig(tenantId, contactId)}`;
}

export function readUnsubscribeToken(
  token: string,
): { tenantId: string; contactId: string } | null {
  const [tenantId, contactId, given] = token.split('.');
  if (!tenantId || !contactId || !given) return null;
  const expected = Buffer.from(sig(tenantId, contactId));
  const actual = Buffer.from(given);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    return null;
  return { tenantId, contactId };
}

/** Public base URL of this API (links in emails, OAuth callbacks). */
export function publicApiUrl() {
  return (
    process.env.API_PUBLIC_URL || `http://localhost:${process.env.PORT || 8888}`
  ).replace(/\/$/, '');
}
