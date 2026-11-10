import { randomBytes } from 'crypto';
import { open, seal } from '../../common/crypto/secret-box';
import { telegramSetWebhook } from '../delivery/messaging-transport';
import { publicApiUrl } from '../delivery/unsubscribe-token';
import type { CollectionDef, HookContext } from '../records/collection.types';
import { fieldError, text, type Row } from '../records/record-store';
import { checkCredentials, type CheckResult } from '../delivery/account-check';
import {
  cleanCredentials,
  providerOf,
  type Credentials,
} from '../delivery/providers';

/** Field on the credentials that identifies the account in lists (host, number…). */
const IDENTIFIER: Record<string, string> = {
  smtp: 'host',
  ses: 'region',
  gmail: 'email',
  outlook: 'email',
  twilio: 'from',
  meta_whatsapp: 'phoneNumber',
  telegram: 'bot',
};

export async function checkStoredAccount(account: Row): Promise<CheckResult> {
  const def = providerOf(account.provider);
  if (!def)
    return {
      ok: false,
      detail: `${text(account.provider)} is not integrated yet.`,
    };
  if (typeof account._credentials !== 'string')
    return {
      ok: false,
      detail: 'No credentials stored. Reconnect the account.',
    };
  let creds: Credentials;
  try {
    creds = open<Credentials>(account._credentials);
  } catch {
    return {
      ok: false,
      detail:
        'Stored credentials cannot be read (the encryption key changed). Reconnect the account.',
    };
  }
  return checkCredentials(def.key, creds);
}

/**
 * Webhook addresses a messaging account needs: shown in the UI for the provider's
 * console (Twilio, Meta) or registered automatically (Telegram, needs HTTPS).
 * `hookKey` names the account in the URL; signatures protect the endpoints.
 */
async function webhookSetup(
  provider: string,
  creds: Credentials,
): Promise<Record<string, unknown>> {
  if (!['twilio', 'meta_whatsapp', 'telegram'].includes(provider)) return {};
  const hookKey = randomBytes(18).toString('base64url');
  const baseUrl = publicApiUrl();
  if (provider === 'twilio') {
    return {
      hookKey,
      setup: {
        inboundUrl: `${baseUrl}/hooks/twilio/${hookKey}/inbound`,
        note: 'In Twilio, set this URL as the number’s “A message comes in” webhook (HTTP POST). Delivery reports are requested automatically.',
      },
    };
  }
  if (provider === 'meta_whatsapp') {
    return {
      hookKey,
      setup: {
        inboundUrl: `${baseUrl}/hooks/meta/${hookKey}`,
        verifyToken: randomBytes(16).toString('hex'),
        note: 'In the Meta app dashboard → WhatsApp → Configuration, set this callback URL and verify token, then subscribe to the “messages” field.',
      },
    };
  }
  // Telegram pushes updates only to HTTPS addresses.
  const inboundUrl = `${baseUrl}/hooks/telegram/${hookKey}`;
  if (!baseUrl.startsWith('https://'))
    return {
      hookKey,
      setup: {
        inboundUrl,
        registered: false,
        note: 'Telegram needs an HTTPS API_PUBLIC_URL to deliver incoming messages. Set it, then use “Check connection”.',
      },
    };
  try {
    await telegramSetWebhook(creds, inboundUrl, creds.webhookSecret);
    return {
      hookKey,
      setup: {
        inboundUrl,
        registered: true,
        note: 'Incoming messages are delivered automatically.',
      },
    };
  } catch (error) {
    return {
      hookKey,
      setup: {
        inboundUrl,
        registered: false,
        note: `Telegram did not accept the webhook: ${(error as Error).message}`,
      },
    };
  }
}

/** Makes `id` the only default account of its channel. */
async function onlyDefault(
  ctx: HookContext,
  channel: string,
  id: string | null,
) {
  await ctx.store.em.query(
    `UPDATE product_records SET data = data || '{"isDefault": false}'::jsonb, updated_at = now()
      WHERE tenant_id = $1 AND collection = 'channel-accounts' AND data->>'channel' = $2
        AND data->>'isDefault' = 'true' AND ($3::uuid IS NULL OR id <> $3::uuid)`,
    [ctx.store.tenantId, channel, id],
  );
}

/**
 * Validates, verifies with the provider and encrypts a credential bag.
 * Returns the fields to store; throws a field error the connect form can show.
 */
async function verifiedCredentials(providerLabel: unknown, creds: Credentials) {
  const def = providerOf(providerLabel)!;
  if (def.oauth && !creds.refreshToken) {
    throw fieldError(
      422,
      'OAUTH_REQUIRED',
      'provider',
      `Use “Connect with ${def.key === 'gmail' ? 'Google' : 'Microsoft'}” to add a ${def.label} account.`,
    );
  }
  const missing = def.required.filter((k) => !creds[k]);
  if (missing.length) {
    throw fieldError(
      422,
      'CREDENTIALS_MISSING',
      `credentials.${missing[0]}`,
      `Fill in ${missing.join(', ')}.`,
    );
  }
  const result = await checkCredentials(def.key, creds);
  if (!result.ok)
    throw fieldError(422, 'CREDENTIALS_REJECTED', 'credentials', result.detail);
  return {
    provider: def.label,
    status: 'connected',
    statusDetail: null,
    lastCheckedAt: new Date().toISOString(),
    ...(result.info?.quality ? { quality: result.info.quality } : {}),
    credentialsSet: true,
    _credentials: seal(creds),
  };
}

/**
 * Channel accounts. Credentials arrive once as `credentials` (never stored in
 * clear), are checked with the provider and sealed into `_credentials`, which is
 * private: never accepted from clients and never returned.
 */
export const channelAccountsCollection: CollectionDef = {
  path: 'channel-accounts',
  read: null,
  write: 'channels.manage',
  searchFields: ['name', 'identifier', 'provider'],
  serverFields: [
    'status',
    'statusDetail',
    'lastCheckedAt',
    'credentialsSet',
    'hookKey',
    'setup',
  ],
  beforeCreate: async (ctx, input) => {
    const { credentials, ...rest } = input;
    const channel = text(rest.channel);
    if (!channel)
      throw fieldError(422, 'REQUIRED', 'channel', 'Choose a channel');
    const def = providerOf(rest.provider);
    const isFirst = !(await ctx.store.count('channel-accounts', { channel }));
    const base = {
      name: text(rest.name).trim() || `${channel} account`,
      throughput: null,
      quality: null,
      ...rest,
      isDefault: isFirst || rest.isDefault === true,
    };
    let stored: Record<string, unknown>;
    if (!def) {
      // Providers without a backend integration yet (Instagram, Telegram…) are saved as pending.
      stored = {
        ...base,
        status: 'pending',
        statusDetail: 'This provider is not integrated yet.',
        credentialsSet: false,
      };
    } else {
      if (!def.channels.includes(channel))
        throw fieldError(
          422,
          'INVALID_PROVIDER',
          'provider',
          `${def.label} does not support ${channel}.`,
        );
      const creds = cleanCredentials(credentials);
      if (def.key === 'telegram')
        creds.webhookSecret = randomBytes(24).toString('hex');
      stored = { ...base, ...(await verifiedCredentials(def.label, creds)) };
      stored.identifier =
        text(rest.identifier) || creds[IDENTIFIER[def.key]] || def.label;
      Object.assign(stored, await webhookSetup(def.key, creds));
    }
    if (stored.isDefault) await onlyDefault(ctx, channel, null);
    return stored;
  },
  beforeUpdate: async (ctx, existing, patch) => {
    const { credentials, ...rest } = patch;
    let out: Record<string, unknown> = rest;
    if (credentials !== undefined) {
      if (!providerOf(existing.provider))
        throw fieldError(
          422,
          'INVALID_PROVIDER',
          'provider',
          'This provider is not integrated yet.',
        );
      let previous: Credentials = {};
      try {
        previous =
          typeof existing._credentials === 'string'
            ? open<Credentials>(existing._credentials)
            : {};
      } catch {
        previous = {};
      }
      // Blank fields keep their stored value, so a form can update only the password.
      out = {
        ...rest,
        ...(await verifiedCredentials(existing.provider, {
          ...previous,
          ...cleanCredentials(credentials),
        })),
      };
    }
    if (rest.isDefault === true)
      await onlyDefault(ctx, text(existing.channel), existing.id);
    return out;
  },
};
