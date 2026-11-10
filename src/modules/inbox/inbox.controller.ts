import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { TenantScoped } from '../../common/decorators/roles.decorator';
import {
  CurrentPrincipal,
  CurrentTenant,
} from '../../common/decorators/user.decorator';
import type { Principal, TenantContext } from '../../common/types/principal';
import { ApiResponse } from '../../common/utils/api.response';
import type { HookContext } from '../records/collection.types';
import { fieldError, text, type Row } from '../records/record-store';
import { RecordsService } from '../records/records.service';
import { conversationMessagesShape } from './inbox.collections';

interface ReplyBody {
  body: string;
  kind: 'message' | 'note';
  attachments?: { name: string; size: number }[];
}

/** Unified inbox actions (docs/API-CONTRACT.md, Phase 8). */
@ApiTags('Inbox')
@Controller('conversations')
@TenantScoped()
export class InboxController {
  constructor(private readonly records: RecordsService) {}

  @Get('counts')
  async counts(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return ApiResponse.success(
      await this.records.exec(tenant, principal, 'inbox.read', (ctx) =>
        this.countsFor(ctx),
      ),
    );
  }

  @Get(':id/messages')
  async messages(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return ApiResponse.success(
      await this.records.exec(tenant, principal, 'inbox.read', async (ctx) => {
        await ctx.store.find('conversations', id);
        const page = await ctx.store.list(
          'conversation-messages',
          conversationMessagesShape,
          {
            filters: { conversationId: id },
            sort: 'at',
            order: 'asc',
            perPage: 200,
          },
        );
        return page.data;
      }),
    );
  }

  @Post(':id/messages')
  async reply(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReplyBody,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return ApiResponse.success(
      await this.records.exec(tenant, principal, 'inbox.reply', (ctx) =>
        this.replyTo(ctx, id, body),
      ),
      'Sent',
      201,
    );
  }

  /** Opening a conversation clears its unread badge. */
  @Post(':id/read')
  @HttpCode(200)
  async read(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return ApiResponse.success(
      await this.records.exec(tenant, principal, 'inbox.read', (ctx) =>
        ctx.store.patch('conversations', id, { unreadCount: 0 }),
      ),
    );
  }

  private async countsFor(ctx: HookContext) {
    const rows = await ctx.store.em.query<
      {
        status: string;
        channel: string;
        mine: boolean;
        unassigned: boolean;
        n: string;
      }[]
    >(
      `SELECT data->>'status' AS status, data->>'channel' AS channel,
              coalesce(data->>'assigneeName' = $2, false) AS mine,
              coalesce(data->>'assigneeName', '') = '' AS unassigned,
              count(*) AS n
       FROM product_records WHERE tenant_id = $1 AND collection = 'conversations'
       GROUP BY 1, 2, 3, 4`,
      [ctx.store.tenantId, ctx.actorName],
    );
    const counts = {
      mine: 0,
      unassigned: 0,
      open: 0,
      pending: 0,
      snoozed: 0,
      resolved: 0,
      byChannel: {} as Record<string, number>,
    };
    for (const r of rows) {
      const n = Number(r.n);
      if (r.status === 'open') {
        counts.open += n;
        if (r.mine) counts.mine += n;
        if (r.unassigned) counts.unassigned += n;
        counts.byChannel[r.channel] = (counts.byChannel[r.channel] ?? 0) + n;
      } else if (r.status in counts) {
        (counts as unknown as Record<string, number>)[r.status] += n;
      }
    }
    return counts;
  }

  private async replyTo(ctx: HookContext, id: string, body: ReplyBody) {
    const message = text(body?.body).trim();
    const kind = body?.kind === 'note' ? 'note' : 'message';
    if (!message)
      throw fieldError(422, 'REQUIRED', 'body', 'Write a message first');
    if (message.length > 10_000) {
      throw fieldError(
        422,
        'TOO_LONG',
        'body',
        'Messages are limited to 10,000 characters',
      );
    }
    const conversation = await ctx.store.find<Row>('conversations', id);
    const expires = conversation.windowExpiresAt as string | null;
    if (
      kind === 'message' &&
      conversation.channel === 'whatsapp' &&
      expires &&
      Date.parse(expires) < Date.now()
    ) {
      throw fieldError(
        422,
        'WHATSAPP_WINDOW_CLOSED',
        'body',
        'The 24-hour window has closed. Send an approved template instead.',
      );
    }
    const attachments = Array.isArray(body.attachments)
      ? body.attachments.slice(0, 10).map((a) => ({
          name: text(a?.name).slice(0, 255),
          size: Number(a?.size) || 0,
        }))
      : [];
    const at = new Date().toISOString();
    const created = await ctx.store.insert('conversation-messages', {
      conversationId: id,
      direction: 'outbound',
      kind,
      body: message,
      authorName: ctx.actorName,
      // The delivery worker sends the reply and moves this to sent / delivered / read / failed.
      status: kind === 'note' ? null : 'sending',
      attachments: kind === 'note' ? [] : attachments,
      at,
    });
    if (kind === 'message') {
      await ctx.store.insert('messages', {
        channel: conversation.channel,
        direction: 'outbound',
        to: text(conversation.contactHandle) || null,
        from: ctx.actorName,
        contactId: conversation.contactId ?? null,
        contactName: conversation.contactName ?? null,
        subject:
          conversation.channel === 'email'
            ? `Re: ${text(conversation.subject) || 'Your message'}`
            : null,
        preview: message.slice(0, 140),
        body: message,
        conversationMessageId: created.id,
        status: 'queued',
        provider: 'unassigned',
        campaignId: null,
        campaignName: null,
        errorCode: null,
        events: [
          { status: 'queued', at, detail: `Inbox reply by ${ctx.actorName}` },
        ],
      });
      await ctx.store.patch('conversations', id, {
        lastMessagePreview: message.slice(0, 200),
        lastMessageAt: at,
        status:
          conversation.status === 'resolved' ? 'open' : conversation.status,
      });
    }
    return created;
  }
}
