import type { Credentials } from './providers';
import { str } from './providers';

/**
 * SMS (Twilio), WhatsApp (Meta Cloud API) and Telegram (Bot API) over their REST
 * APIs with fetch, no SDKs. Base URLs can be overridden (TWILIO_API_BASE,
 * META_GRAPH_BASE, TELEGRAM_API_BASE) so tests run against a local fake.
 */
const TIMEOUT = 20_000;
export const META_GRAPH_VERSION = 'v21.0';

const twilioBase = () =>
  (process.env.TWILIO_API_BASE || 'https://api.twilio.com').replace(/\/$/, '');
const metaBase = () =>
  (process.env.META_GRAPH_BASE || 'https://graph.facebook.com').replace(
    /\/$/,
    '',
  );
const telegramBase = () =>
  (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(
    /\/$/,
    '',
  );

/** A provider refusal, with whether retrying could help. */
export class ProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly permanent: boolean,
  ) {
    super(message);
  }
}

async function request(url: string, init: RequestInit) {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) });
  } catch (error) {
    throw new ProviderError(
      'TEMPORARY',
      `Network error: ${(error as Error).message}`,
      false,
    );
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { res, body };
}

/** 429 and 5xx are worth retrying; other 4xx are not. */
const retryable = (status: number) => status === 429 || status >= 500;

// ---------- Twilio SMS ----------

export async function twilioSend(
  c: Credentials,
  m: { to: string; body: string; statusCallback?: string },
) {
  const form = new URLSearchParams({ To: m.to, Body: m.body });
  if (c.messagingServiceSid)
    form.set('MessagingServiceSid', c.messagingServiceSid);
  else form.set('From', c.from);
  if (m.statusCallback) form.set('StatusCallback', m.statusCallback);
  const { res, body } = await request(
    `${twilioBase()}/2010-04-01/Accounts/${encodeURIComponent(c.accountSid)}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${c.accountSid}:${c.authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form,
    },
  );
  if (!res.ok) {
    const code = str(body.code, String(res.status));
    // 21211 invalid number, 21610 unsubscribed (STOP), 21408 region not enabled.
    throw new ProviderError(
      code === '21610' ? 'UNSUBSCRIBED' : `TWILIO_${code}`,
      `Twilio: ${str(body.message, res.statusText)}`,
      !retryable(res.status),
    );
  }
  return {
    providerMessageId: str(body.sid, ''),
    segments: Number(body.num_segments) || 1,
    status: str(body.status, 'queued'),
  };
}

// ---------- Meta WhatsApp Cloud API ----------

function metaError(res: Response, body: Record<string, unknown>) {
  const err = (body.error ?? {}) as {
    message?: string;
    code?: number;
    error_data?: { details?: string };
  };
  // 131047: outside the 24-hour window; 131026: undeliverable; 132xxx: template problems.
  const code = str(err.code, String(res.status));
  const message = `WhatsApp: ${err.error_data?.details ?? err.message ?? res.statusText}`;
  return new ProviderError(
    code === '131047' ? 'WINDOW_CLOSED' : `META_${code}`,
    message,
    !retryable(res.status) && code !== '130429',
  );
}

async function metaPost(c: Credentials, payload: Record<string, unknown>) {
  const { res, body } = await request(
    `${metaBase()}/${META_GRAPH_VERSION}/${encodeURIComponent(c.phoneNumberId)}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${c.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        ...payload,
      }),
    },
  );
  if (!res.ok) throw metaError(res, body);
  const id =
    ((body.messages as { id?: string }[] | undefined) ?? [])[0]?.id ?? '';
  return { providerMessageId: id };
}

const waNumber = (to: string) => to.replace(/[^\d]/g, '');

/** An approved template (works outside the 24-hour window). */
export function whatsappTemplate(
  c: Credentials,
  m: {
    to: string;
    name: string;
    language: string;
    bodyParams: string[];
    headerParam?: { type: 'text' | 'image'; value: string } | null;
  },
) {
  const components: Record<string, unknown>[] = [];
  if (m.headerParam?.value) {
    components.push({
      type: 'header',
      parameters: [
        m.headerParam.type === 'image'
          ? { type: 'image', image: { link: m.headerParam.value } }
          : { type: 'text', text: m.headerParam.value },
      ],
    });
  }
  if (m.bodyParams.length)
    components.push({
      type: 'body',
      parameters: m.bodyParams.map((t) => ({ type: 'text', text: t || '-' })),
    });
  return metaPost(c, {
    to: waNumber(m.to),
    type: 'template',
    template: {
      name: m.name,
      language: { code: m.language || 'en' },
      ...(components.length ? { components } : {}),
    },
  });
}

/** Free-form text (only inside the 24-hour customer service window: inbox replies). */
export function whatsappText(c: Credentials, m: { to: string; body: string }) {
  return metaPost(c, {
    to: waNumber(m.to),
    type: 'text',
    text: { preview_url: true, body: m.body },
  });
}

/** Submits a template for Meta's review. Returns Meta's template id and status. */
export async function whatsappSubmitTemplate(
  c: Credentials,
  t: {
    name: string;
    language: string;
    category: string;
    components: Record<string, unknown>[];
  },
) {
  const { res, body } = await request(
    `${metaBase()}/${META_GRAPH_VERSION}/${encodeURIComponent(c.wabaId)}/message_templates`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${c.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: t.name,
        language: t.language,
        category: t.category,
        components: t.components,
      }),
    },
  );
  if (!res.ok) throw metaError(res, body);
  return {
    id: str(body.id, ''),
    status: str(body.status, 'PENDING'),
  };
}

/** Current review status of a template by name (APPROVED, REJECTED, PENDING…). */
export async function whatsappTemplateStatus(c: Credentials, name: string) {
  const url = `${metaBase()}/${META_GRAPH_VERSION}/${encodeURIComponent(c.wabaId)}/message_templates?name=${encodeURIComponent(name)}&fields=name,status,rejected_reason,language`;
  const { res, body } = await request(url, {
    headers: { Authorization: `Bearer ${c.accessToken}` },
  });
  if (!res.ok) throw metaError(res, body);
  const rows =
    (body.data as
      | { status?: string; rejected_reason?: string }[]
      | undefined) ?? [];
  return rows[0] ?? null;
}

// ---------- Telegram Bot API ----------

async function telegram(
  c: Credentials,
  method: string,
  payload?: Record<string, unknown>,
) {
  const { res, body } = await request(
    `${telegramBase()}/bot${c.botToken}/${method}`,
    {
      method: payload ? 'POST' : 'GET',
      headers: payload ? { 'Content-Type': 'application/json' } : undefined,
      body: payload ? JSON.stringify(payload) : undefined,
    },
  );
  if (!res.ok || body.ok === false) {
    const status = Number(body.error_code ?? res.status);
    // 403: the user blocked the bot or never started it.
    throw new ProviderError(
      status === 403 ? 'BLOCKED' : `TELEGRAM_${status}`,
      `Telegram: ${str(body.description, res.statusText)}`,
      !retryable(status),
    );
  }
  return body.result as Record<string, unknown>;
}

export async function telegramSend(
  c: Credentials,
  m: { chatId: string; body: string },
) {
  const result = await telegram(c, 'sendMessage', {
    chat_id: m.chatId,
    text: m.body,
  });
  return { providerMessageId: str(result.message_id, '') };
}

export const telegramMe = (c: Credentials) => telegram(c, 'getMe');

/** Points the bot's updates at our webhook, with a secret Telegram echoes in a header. */
export const telegramSetWebhook = (
  c: Credentials,
  url: string,
  secret: string,
) =>
  telegram(c, 'setWebhook', {
    url,
    secret_token: secret,
    allowed_updates: ['message'],
  });
