import { describeSendError, emailSender } from './email-transport';
import { str } from './providers';
import { telegramMe } from './messaging-transport';
import type { Credentials, ProviderKey } from './providers';

export interface CheckResult {
  ok: boolean;
  detail: string;
  /** Provider facts worth showing (WhatsApp quality rating…). */
  info?: Record<string, string>;
}

const TIMEOUT = 15_000;
/** Provider API base URL, overridable for tests (TWILIO_API_BASE, META_GRAPH_BASE). */
const base = (env: string, fallback: string) =>
  (process.env[env] || fallback).replace(/\/$/, '');

async function getJson(url: string, headers: Record<string, string>) {
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, body };
}

/** Verifies credentials with the provider. Never throws: returns a readable result. */
export async function checkCredentials(
  provider: ProviderKey,
  c: Credentials,
): Promise<CheckResult> {
  try {
    switch (provider) {
      case 'smtp':
      case 'ses':
      case 'gmail':
      case 'outlook': {
        const sender = emailSender(provider, c);
        try {
          await sender.verify();
        } finally {
          sender.close();
        }
        return {
          ok: true,
          detail: 'Connected: the provider accepted the credentials.',
        };
      }
      case 'twilio': {
        const auth = Buffer.from(`${c.accountSid}:${c.authToken}`).toString(
          'base64',
        );
        const r = await getJson(
          `${base('TWILIO_API_BASE', 'https://api.twilio.com')}/2010-04-01/Accounts/${encodeURIComponent(c.accountSid)}.json`,
          { Authorization: `Basic ${auth}` },
        );
        if (!r.ok)
          return {
            ok: false,
            detail:
              `Twilio rejected the credentials (${r.status}): ${str(r.body.message, '')}`.trim(),
          };
        if (r.body.status !== 'active')
          return {
            ok: false,
            detail: `The Twilio account is ${String(r.body.status)}.`,
          };
        return {
          ok: true,
          detail: `Connected to Twilio account “${str(r.body.friendly_name, c.accountSid)}”.`,
        };
      }
      case 'telegram': {
        const me = await telegramMe(c);
        return {
          ok: true,
          detail: `Connected to bot @${str(me.username, '')}.`,
          info: { username: str(me.username, '') },
        };
      }
      case 'meta_whatsapp': {
        const r = await getJson(
          `${base('META_GRAPH_BASE', 'https://graph.facebook.com')}/v21.0/${encodeURIComponent(c.phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating`,
          { Authorization: `Bearer ${c.accessToken}` },
        );
        const err = r.body.error as { message?: string } | undefined;
        if (!r.ok)
          return {
            ok: false,
            detail:
              `Meta rejected the request (${r.status}): ${err?.message ?? ''}`.trim(),
          };
        return {
          ok: true,
          detail: `Connected to ${str(r.body.verified_name, 'WhatsApp')} (${str(r.body.display_phone_number, c.phoneNumberId)}).`,
          info: { quality: str(r.body.quality_rating, '').toLowerCase() },
        };
      }
    }
  } catch (error) {
    return { ok: false, detail: describeSendError(error).message };
  }
}
