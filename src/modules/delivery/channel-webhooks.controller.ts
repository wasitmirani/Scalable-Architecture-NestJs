import {
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  VERSION_NEUTRAL,
  type RawBodyRequest,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { createHmac, timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';
import { DataSource } from 'typeorm';
import { open } from '../../common/crypto/secret-box';
import { Public } from '../../common/decorators/public.decorator';
import { text, type Row } from '../records/record-store';
import { RecordsService } from '../records/records.service';
import { InboundService } from './inbound.service';
import type { Credentials } from './providers';
import { publicApiUrl } from './unsubscribe-token';

const forbidden = (message: string) =>
  new HttpException(
    { message, code: 'INVALID_SIGNATURE', error: 'Forbidden' },
    HttpStatus.FORBIDDEN,
  );
const notFound = () =>
  new HttpException(
    { message: 'Unknown webhook', code: 'NOT_FOUND', error: 'Not Found' },
    HttpStatus.NOT_FOUND,
  );

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Twilio: base64 HMAC-SHA1 of the full URL followed by the sorted POST params. */
export function twilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
) {
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join('');
  return createHmac('sha1', authToken).update(data).digest('base64');
}

const TWILIO_STATUS: Record<string, string> = {
  queued: 'queued',
  accepted: 'queued',
  sending: 'queued',
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  undelivered: 'failed',
  failed: 'failed',
};

/**
 * Provider webhooks (outside /api/v1, no auth header): incoming messages and
 * delivery reports. `:key` is the account's public hookKey; every request is
 * verified with the provider's signature scheme before anything is written.
 */
@ApiExcludeController()
@Public()
@Controller({ path: 'hooks', version: VERSION_NEUTRAL })
export class ChannelWebhooksController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly records: RecordsService,
    private readonly inbound: InboundService,
  ) {}

  /** The account a webhook key belongs to (any workspace). */
  private async account(provider: string, key: string) {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(key)) throw notFound();
    const [row] = await this.dataSource.query<
      { id: string; tenant_id: string; data: Row }[]
    >(
      `SELECT id, tenant_id, data FROM product_records WHERE collection = 'channel-accounts' AND data->>'hookKey' = $1 LIMIT 1`,
      [key],
    );
    if (
      !row ||
      text(row.data.provider) !== provider ||
      typeof row.data._credentials !== 'string'
    )
      throw notFound();
    return {
      id: row.id,
      channel: text(row.data.channel),
      setup: (row.data.setup ?? {}) as Record<string, string>,
      creds: open<Credentials>(row.data._credentials),
      tenant: {
        tenantId: row.tenant_id,
        memberId: null,
        roleKey: null,
        permissions: new Set<string>(),
      },
    };
  }

  // ---------- Twilio ----------

  @Post('twilio/:key/:kind')
  @HttpCode(200)
  async twilio(
    @Param('key') key: string,
    @Param('kind') kind: string,
    @Req() req: Request,
    @Headers('x-twilio-signature') signature: string | undefined,
    @Res() res: Response,
  ) {
    const acc = await this.account('Twilio', key);
    const params = Object.fromEntries(
      Object.entries((req.body ?? {}) as Record<string, unknown>).map(
        ([k, v]) => [k, String(v)],
      ),
    );
    const url = `${publicApiUrl()}${req.originalUrl}`;
    if (
      !signature ||
      !safeEqual(signature, twilioSignature(acc.creds.authToken, url, params))
    )
      throw forbidden('Twilio signature does not match');

    await this.records.run(acc.tenant, 'Twilio', async (ctx) => {
      if (kind === 'inbound') {
        await this.inbound.receive(ctx, {
          channel: 'sms',
          accountId: acc.id,
          from: params.From,
          body: params.Body ?? '',
          providerMessageId: params.MessageSid,
        });
      } else if (kind === 'status') {
        const status = TWILIO_STATUS[params.MessageStatus ?? ''];
        if (status && status !== 'queued')
          await this.inbound.status(
            ctx,
            params.MessageSid,
            status,
            status === 'failed'
              ? {
                  code: `TWILIO_${params.ErrorCode ?? 'FAILED'}`,
                  message: `Twilio reported ${params.MessageStatus}${params.ErrorCode ? ` (error ${params.ErrorCode})` : ''}`,
                }
              : undefined,
          );
      }
    });
    // Empty TwiML: no automatic reply (replies come from the inbox or automations).
    res
      .type('text/xml')
      .send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  }

  // ---------- Meta WhatsApp ----------

  /** Meta's subscription check: echo the challenge when the verify token matches. */
  @Get('meta/:key')
  async metaVerify(
    @Param('key') key: string,
    @Query() q: Record<string, string>,
    @Res() res: Response,
  ) {
    const acc = await this.account('Meta Cloud API', key);
    if (
      q['hub.mode'] !== 'subscribe' ||
      !acc.setup.verifyToken ||
      !safeEqual(q['hub.verify_token'] ?? '', acc.setup.verifyToken)
    )
      throw forbidden('Verify token does not match');
    res.type('text/plain').send(q['hub.challenge'] ?? '');
  }

  @Post('meta/:key')
  @HttpCode(200)
  async meta(
    @Param('key') key: string,
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-hub-signature-256') signature: string | undefined,
  ) {
    const acc = await this.account('Meta Cloud API', key);
    const raw = req.rawBody?.toString('utf8') ?? JSON.stringify(req.body ?? {});
    const expected = `sha256=${createHmac('sha256', acc.creds.appSecret ?? '')
      .update(raw)
      .digest('hex')}`;
    if (!signature || !safeEqual(signature, expected))
      throw forbidden('Meta signature does not match');

    type Change = {
      value?: {
        contacts?: { wa_id?: string; profile?: { name?: string } }[];
        messages?: {
          from?: string;
          id?: string;
          timestamp?: string;
          type?: string;
          text?: { body?: string };
          button?: { text?: string };
          interactive?: {
            button_reply?: { title?: string };
            list_reply?: { title?: string };
          };
        }[];
        statuses?: {
          id?: string;
          status?: string;
          errors?: { code?: number; title?: string; message?: string }[];
        }[];
      };
    };
    const body = req.body as { entry?: { changes?: Change[] }[] };
    await this.records.run(acc.tenant, 'WhatsApp', async (ctx) => {
      for (const change of (body.entry ?? []).flatMap((e) => e.changes ?? [])) {
        const v = change.value ?? {};
        for (const m of v.messages ?? []) {
          const name = v.contacts?.find((c) => c.wa_id === m.from)?.profile
            ?.name;
          const content =
            m.text?.body ??
            m.button?.text ??
            m.interactive?.button_reply?.title ??
            m.interactive?.list_reply?.title ??
            `[${m.type ?? 'message'}]`;
          await this.inbound.receive(ctx, {
            channel: 'whatsapp',
            accountId: acc.id,
            from: m.from ?? '',
            name,
            body: content,
            providerMessageId: m.id,
            at: m.timestamp
              ? new Date(Number(m.timestamp) * 1000).toISOString()
              : undefined,
          });
        }
        for (const s of v.statuses ?? []) {
          const err = s.errors?.[0];
          await this.inbound.status(
            ctx,
            s.id ?? '',
            s.status ?? '',
            s.status === 'failed'
              ? {
                  code: `META_${err?.code ?? 'FAILED'}`,
                  message: `WhatsApp: ${err?.message ?? err?.title ?? 'delivery failed'}`,
                }
              : undefined,
          );
        }
      }
    });
    return { received: true };
  }

  // ---------- Telegram ----------

  @Post('telegram/:key')
  @HttpCode(200)
  async telegram(
    @Param('key') key: string,
    @Req() req: Request,
    @Headers('x-telegram-bot-api-secret-token') secret: string | undefined,
  ) {
    const acc = await this.account('Telegram', key);
    if (!secret || !safeEqual(secret, acc.creds.webhookSecret ?? ''))
      throw forbidden('Telegram secret token does not match');
    const update = req.body as {
      message?: {
        message_id?: number;
        date?: number;
        text?: string;
        caption?: string;
        chat?: { id?: number };
        from?: { first_name?: string; last_name?: string; username?: string };
      };
    };
    const m = update.message;
    if (!m?.chat?.id) return { ok: true }; // edits, joins and other updates are ignored
    await this.records.run(acc.tenant, 'Telegram', (ctx) =>
      this.inbound.receive(ctx, {
        channel: 'telegram',
        accountId: acc.id,
        from: String(m.chat!.id),
        name:
          [m.from?.first_name, m.from?.last_name].filter(Boolean).join(' ') ||
          m.from?.username,
        body: m.text ?? m.caption ?? '[attachment]',
        providerMessageId: m.message_id ? String(m.message_id) : undefined,
        at: m.date ? new Date(m.date * 1000).toISOString() : undefined,
      }),
    );
    return { ok: true };
  }
}
