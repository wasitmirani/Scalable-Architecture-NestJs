import {
  Controller,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Req,
  VERSION_NEUTRAL,
  type RawBodyRequest,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import type { Request } from 'express';
import { DataSource } from 'typeorm';
import { Public } from '../../common/decorators/public.decorator';
import { ApiResponse } from '../../common/utils/api.response';
import { contactDefaults } from '../crm/crm.collections';
import { RecordsService } from '../records/records.service';
import { text, type Row } from '../records/record-store';
import { AutomationService } from './automation.service';
import type { Contact } from './engine/engine';
import type { Workflow } from './engine/types';
import { flattenPayload, samplePayloadValues } from './engine/workflow';
import { contactCapacity } from '../platform/plan-limits';

const MAX_BODY_BYTES = 256 * 1024;
const RATE_LIMIT = 120; // requests per token per minute
const hits = new Map<string, number[]>();

function rateLimited(token: string) {
  const now = Date.now();
  const recent = (hits.get(token) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(token, recent);
  if (hits.size > 10_000) hits.clear(); // bound memory under token spraying
  return recent.length > RATE_LIMIT;
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const fail = (status: HttpStatus, code: string, message: string) =>
  new HttpException({ message, code, error: HttpStatus[status] }, status);

/**
 * Public incoming-webhook trigger: `POST /hooks/workflows/:token` (outside `/api/v1`,
 * no auth header; the token names the workflow). See docs/API-CONTRACT.md, Phase 10.
 */
@ApiExcludeController()
@Public()
@Controller({ path: 'hooks/workflows', version: VERSION_NEUTRAL })
export class WorkflowHooksController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly records: RecordsService,
    private readonly automation: AutomationService,
  ) {}

  @Post(':token')
  @HttpCode(202)
  async receive(
    @Param('token') token: string,
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-birdcrm-signature') signature: string | undefined,
    @Headers('x-webhook-secret') sharedSecret: string | undefined,
  ) {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(token))
      throw fail(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Unknown webhook');
    if (rateLimited(token))
      throw fail(
        HttpStatus.TOO_MANY_REQUESTS,
        'RATE_LIMITED',
        'Too many requests for this webhook',
      );

    const raw = req.rawBody?.toString('utf8') ?? JSON.stringify(req.body ?? {});
    if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
      throw fail(
        HttpStatus.PAYLOAD_TOO_LARGE,
        'BODY_TOO_LARGE',
        'Bodies are limited to 256 KB',
      );
    }

    // Look up by the token in the live version, across workspaces (no tenant header here).
    const [match] = await this.dataSource.query<
      { id: string; tenant_id: string }[]
    >(
      `SELECT id, tenant_id FROM product_records
       WHERE collection = 'workflows' AND data->>'status' = 'active'
         AND data->'versions'->-1->'definition'->'trigger'->>'type' = 'incoming_webhook'
         AND data->'versions'->-1->'definition'->'trigger'->'config'->>'token' = $1
       LIMIT 1`,
      [token],
    );
    if (!match)
      throw fail(
        HttpStatus.NOT_FOUND,
        'NOT_FOUND',
        'Unknown webhook or the automation is not live',
      );

    const tenant = {
      tenantId: match.tenant_id,
      memberId: null,
      roleKey: null,
      permissions: new Set<string>(),
    };
    const requestId = `req_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

    await this.records.run(tenant, 'Incoming webhook', async (ctx) => {
      const w = await ctx.store.find<Row & Workflow>('workflows', match.id);
      const def = w.versions.at(-1)!.definition;
      const config = def.trigger.config;

      if (config.auth === 'signature') {
        const expected = `sha256=${createHmac('sha256', config.secret ?? '')
          .update(raw)
          .digest('hex')}`;
        if (!signature || !safeEqual(signature, expected)) {
          throw fail(
            HttpStatus.UNAUTHORIZED,
            'INVALID_SIGNATURE',
            'Signature does not match',
          );
        }
      } else if (config.auth === 'secret') {
        if (!sharedSecret || !safeEqual(sharedSecret, config.secret ?? '')) {
          throw fail(
            HttpStatus.UNAUTHORIZED,
            'INVALID_SECRET',
            'Secret does not match',
          );
        }
      }

      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        throw fail(
          HttpStatus.BAD_REQUEST,
          'INVALID_BODY',
          'Send a JSON object',
        );
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw fail(
          HttpStatus.BAD_REQUEST,
          'INVALID_BODY',
          'Send a JSON object',
        );
      }

      const fields = Object.fromEntries(
        flattenPayload(body as Record<string, unknown>),
      );
      const identifier = (fields[config.contactPath ?? ''] ?? '').trim();
      if (!identifier) {
        throw fail(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'CONTACT_FIELD_MISSING',
          `The body has no “${config.contactPath}” field`,
        );
      }

      const by = config.matchBy ?? 'email';
      let contact = await this.automation.findContact(ctx, by, identifier);
      // A full plan accepts the request but creates nobody (the sender should not retry).
      if (
        !contact &&
        config.createContact === 'true' &&
        by !== 'id' &&
        (await contactCapacity(ctx)) > 0
      ) {
        contact = await ctx.store.insert<Row & Contact>(
          'contacts',
          contactDefaults({
            [by === 'phone' ? 'phone' : 'email']: identifier,
            source: 'webhook',
            consents: { email: 'none' },
          }),
        );
      }
      if (!contact) return; // accepted; nobody to enrol

      const trigger = {
        ...samplePayloadValues({
          type: 'incoming_webhook',
          config: { ...config, samplePayload: raw },
        }),
        received_at: new Date().toISOString(),
        request_id: requestId,
      };
      const run = await this.automation.enrol(ctx, w, contact, trigger);
      if (run) await ctx.store.patch('executions', run.id, { requestId });
    });

    return ApiResponse.success({ requestId: text(requestId) }, 'Accepted', 202);
  }
}
