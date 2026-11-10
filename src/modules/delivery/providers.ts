/**
 * Channel providers the backend can talk to. The UI shows the label (stored on
 * the account as `provider`); the backend works with the key.
 */
export type ProviderKey =
  | 'smtp'
  | 'ses'
  | 'gmail'
  | 'outlook'
  | 'twilio'
  | 'meta_whatsapp';

interface ProviderDef {
  key: ProviderKey;
  label: string;
  channels: string[];
  /** Credential fields that must be present. */
  required: string[];
  /** Connected with an OAuth redirect instead of a form. */
  oauth?: boolean;
}

export const PROVIDERS: ProviderDef[] = [
  { key: 'smtp', label: 'SMTP', channels: ['email'], required: ['host', 'port'] },
  { key: 'ses', label: 'Amazon SES', channels: ['email'], required: ['region', 'accessKeyId', 'secretAccessKey'] },
  { key: 'gmail', label: 'Gmail', channels: ['email'], required: ['email', 'refreshToken'], oauth: true },
  { key: 'outlook', label: 'Outlook', channels: ['email'], required: ['email', 'refreshToken'], oauth: true },
  { key: 'twilio', label: 'Twilio', channels: ['sms', 'voice'], required: ['accountSid', 'authToken'] },
  { key: 'meta_whatsapp', label: 'Meta Cloud API', channels: ['whatsapp'], required: ['phoneNumberId', 'accessToken'] },
];

/** `'Amazon SES'` or `'ses'` → the provider definition. */
export function providerOf(provider: unknown): ProviderDef | null {
  const p = String(provider ?? '').trim().toLowerCase();
  return PROVIDERS.find((d) => d.key === p || d.label.toLowerCase() === p) ?? null;
}

/** Stored credential bag: string values only. */
export type Credentials = Record<string, string>;

export function cleanCredentials(input: unknown): Credentials {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  return Object.fromEntries(
    Object.entries(input as Record<string, unknown>)
      .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
      .map(([k, v]) => [k, String(v).trim()])
      .filter(([, v]) => v !== ''),
  );
}
