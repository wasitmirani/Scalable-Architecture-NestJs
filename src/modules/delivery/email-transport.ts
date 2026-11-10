import {
  GetAccountCommand,
  SendEmailCommand,
  SESv2Client,
} from '@aws-sdk/client-sesv2';
import { createTransport, type Transporter } from 'nodemailer';
import type { Credentials, ProviderKey } from './providers';

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const MICROSOFT_TOKEN_URL =
  'https://login.microsoftonline.com/common/oauth2/v2.0/token';

const TIMEOUTS = {
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 30_000,
};

export interface OutgoingEmail {
  from: string;
  to: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
}

export interface EmailSender {
  /** Checks the credentials with the provider; throws a readable error. */
  verify(): Promise<void>;
  /** Sends one message and returns the provider's message id. */
  send(message: OutgoingEmail): Promise<{ providerMessageId: string }>;
  /** Mailbox providers send only as the connected address. */
  fixedFrom: string | null;
  close(): void;
}

function oauthApp(provider: 'gmail' | 'outlook') {
  const prefix = provider === 'gmail' ? 'GOOGLE' : 'MICROSOFT';
  const clientId = process.env[`${prefix}_OAUTH_CLIENT_ID`] ?? '';
  const clientSecret = process.env[`${prefix}_OAUTH_CLIENT_SECRET`] ?? '';
  if (!clientId || !clientSecret) {
    throw new Error(
      `${provider === 'gmail' ? 'Gmail' : 'Outlook'} is not configured on this server (${prefix}_OAUTH_CLIENT_ID / ${prefix}_OAUTH_CLIENT_SECRET).`,
    );
  }
  return { clientId, clientSecret };
}

/** Builds a sender for an email channel account. */
export function emailSender(
  provider: ProviderKey,
  c: Credentials,
): EmailSender {
  if (provider === 'ses') {
    const client = new SESv2Client({
      region: c.region,
      credentials: {
        accessKeyId: c.accessKeyId,
        secretAccessKey: c.secretAccessKey,
      },
    });
    const transport = createTransport({
      SES: { sesClient: client, SendEmailCommand },
    });
    return {
      fixedFrom: null,
      async verify() {
        const account = await client.send(new GetAccountCommand({}));
        if (account.SendingEnabled === false)
          throw new Error('Sending is paused on this SES account.');
      },
      async send(m) {
        const info = await transport.sendMail({
          ...m,
          ...(c.configurationSet
            ? { ses: { ConfigurationSetName: c.configurationSet } }
            : {}),
        } as Parameters<Transporter['sendMail']>[0]);
        return { providerMessageId: String(info.messageId ?? '') };
      },
      close: () => {
        transport.close();
        client.destroy();
      },
    };
  }

  let transport: Transporter;
  let fixedFrom: string | null = null;
  if (provider === 'smtp') {
    const port = Number(c.port) || 587;
    transport = createTransport({
      host: c.host,
      port,
      secure: c.secure ? c.secure === 'true' : port === 465,
      requireTLS: port === 587,
      auth: c.username
        ? { user: c.username, pass: c.password ?? '' }
        : undefined,
      ...TIMEOUTS,
    });
  } else if (provider === 'gmail' || provider === 'outlook') {
    const app = oauthApp(provider);
    fixedFrom = c.email;
    transport = createTransport({
      ...(provider === 'gmail'
        ? { host: 'smtp.gmail.com', port: 465, secure: true }
        : {
            host: 'smtp.office365.com',
            port: 587,
            secure: false,
            requireTLS: true,
          }),
      auth: {
        type: 'OAuth2',
        user: c.email,
        clientId: app.clientId,
        clientSecret: app.clientSecret,
        refreshToken: c.refreshToken,
        accessUrl:
          provider === 'gmail' ? GOOGLE_TOKEN_URL : MICROSOFT_TOKEN_URL,
      },
      ...TIMEOUTS,
    });
  } else {
    throw new Error(`${provider} is not an email provider`);
  }

  return {
    fixedFrom,
    async verify() {
      await transport.verify();
    },
    async send(m) {
      const info = await transport.sendMail(m);
      return { providerMessageId: String(info.messageId ?? '') };
    },
    close: () => transport.close(),
  };
}

/** Turns provider and network errors into a short, readable reason. */
export function describeSendError(error: unknown): {
  code: string;
  message: string;
  permanent: boolean;
} {
  const e = error as {
    code?: string;
    responseCode?: number;
    name?: string;
    message?: string;
  };
  const message = (e?.message ?? String(error))
    .replace(/\s+/g, ' ')
    .slice(0, 300);
  if (
    e?.responseCode === 535 ||
    /auth|credential|invalid_grant|unauthor/i.test(message)
  )
    return { code: 'AUTH_FAILED', message, permanent: false };
  if (e?.responseCode && e.responseCode >= 550 && e.responseCode < 560)
    return { code: 'REJECTED', message, permanent: true };
  if (
    /MessageRejected|not verified|Email address is not verified/i.test(
      `${e?.name} ${message}`,
    )
  )
    return { code: 'SENDER_NOT_VERIFIED', message, permanent: true };
  if (
    /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET|timeout|Throttl|rate/i.test(
      `${e?.code} ${message}`,
    )
  )
    return { code: 'TEMPORARY', message, permanent: false };
  return { code: 'SEND_FAILED', message, permanent: false };
}
