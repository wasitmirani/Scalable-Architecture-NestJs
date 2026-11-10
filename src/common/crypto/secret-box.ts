import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { Logger } from '@nestjs/common';

/**
 * Encryption at rest for provider credentials (SMTP passwords, AWS keys, OAuth
 * refresh tokens, Twilio/Meta tokens, payment keys). AES-256-GCM, a random
 * 12-byte IV per value; the stored form is `v1:<iv>:<tag>:<ciphertext>` (base64url).
 *
 * Key: SECRETS_ENCRYPTION_KEY (any string of 32+ characters; hashed to 32 bytes).
 * Required in production. In development it falls back to a key derived from
 * JWT_SECRET so local setups keep working.
 * Rotating the key makes existing secrets unreadable: reconnect the accounts.
 */
const VERSION = 'v1';
let cached: Buffer | null = null;

function key(): Buffer {
  if (cached) return cached;
  const configured = process.env.SECRETS_ENCRYPTION_KEY ?? '';
  if (configured.length >= 32) {
    cached = createHash('sha256').update(configured).digest();
    return cached;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SECRETS_ENCRYPTION_KEY must be set (32+ characters) in production');
  }
  new Logger('SecretBox').warn(
    'SECRETS_ENCRYPTION_KEY is not set; using a development key derived from JWT_SECRET.',
  );
  cached = createHash('sha256')
    .update(`linqflow-dev-secrets:${process.env.JWT_SECRET ?? ''}`)
    .digest();
  return cached;
}

const b64 = (b: Buffer) => b.toString('base64url');

/** Encrypts a JSON-serialisable value. */
export function seal(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [VERSION, b64(iv), b64(cipher.getAuthTag()), b64(body)].join(':');
}

/** Decrypts a value from `seal`. Throws if it was tampered with or the key changed. */
export function open<T = unknown>(sealed: string): T {
  const [version, iv, tag, body] = sealed.split(':');
  if (version !== VERSION || !iv || !tag || !body) throw new Error('Unreadable secret');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  const text = Buffer.concat([
    decipher.update(Buffer.from(body, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
  return JSON.parse(text) as T;
}

/** For tests: forget the cached key after changing the environment. */
export function resetSecretKeyForTests() {
  cached = null;
}
