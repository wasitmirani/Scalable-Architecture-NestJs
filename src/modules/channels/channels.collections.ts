import type { CollectionDef } from '../records/collection.types';
import { fieldError, text } from '../records/record-store';

const channelResource = (
  path: string,
  searchFields: string[],
): CollectionDef => ({
  path,
  read: null,
  write: 'channels.manage',
  searchFields,
});

/** Credential handling and provider checks live in ./channel-accounts. */
export { channelAccountsCollection } from './channel-accounts';
export const emailSendersCollection: CollectionDef = {
  ...channelResource('email-senders', ['name', 'email']),
  serverFields: ['verified'],
  beforeCreate: (_ctx, input) => ({
    replyTo: null,
    isDefault: false,
    ...input,
    verified: false,
  }),
};
export const phoneNumbersCollection = channelResource('phone-numbers', [
  'number',
  'label',
]);
export const livechatWidgetsCollection = channelResource('livechat-widgets', [
  'name',
  'domain',
]);

/**
 * DNS records a sending domain must publish (fully qualified hosts, as the UI shows them).
 * Verification resolves them for real (ChannelsService.verifyDomain).
 */
export function domainRecords(domain: string) {
  return [
    {
      type: 'TXT',
      purpose: 'spf',
      host: domain,
      value: 'v=spf1 include:amazonses.com ~all',
      status: 'pending',
    },
    {
      type: 'CNAME',
      purpose: 'dkim',
      host: `bird1._domainkey.${domain}`,
      value: 'bird1.dkim.amazonses.com',
      status: 'pending',
    },
    {
      type: 'TXT',
      purpose: 'dmarc',
      host: `_dmarc.${domain}`,
      value: `v=DMARC1; p=none; rua=mailto:dmarc@${domain}`,
      status: 'pending',
    },
    {
      type: 'CNAME',
      purpose: 'tracking',
      host: `link.${domain}`,
      value: 'track.birdcrm.app',
      status: 'pending',
    },
  ];
}

export const senderDomainsCollection: CollectionDef = {
  ...channelResource('sender-domains', ['domain']),
  serverFields: ['status', 'records', 'lastCheckedAt'],
  beforeCreate: async (ctx, input) => {
    const domain = text(input.domain)
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '');
    if (!/^(?=.{4,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/.test(domain)) {
      throw fieldError(
        422,
        'INVALID_DOMAIN',
        'domain',
        'Enter a domain like mail.example.com',
      );
    }
    if (await ctx.store.count('sender-domains', { domain })) {
      throw fieldError(
        409,
        'DOMAIN_EXISTS',
        'domain',
        'This domain is already added',
      );
    }
    return {
      ...input,
      domain,
      status: 'pending',
      records: domainRecords(domain),
      lastCheckedAt: null,
    };
  },
};

export const callsCollection: CollectionDef = {
  path: 'calls',
  read: 'voice.read',
  write: 'voice.manage',
  searchFields: ['from', 'to', 'contactName', 'agentName'],
  defaultSort: 'startedAt',
};
export const ivrMenusCollection: CollectionDef = {
  path: 'ivr-menus',
  read: 'voice.read',
  write: 'voice.manage',
  searchFields: ['name'],
};
