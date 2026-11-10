import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { TenantScoped } from '../../common/decorators/roles.decorator';
import {
  CurrentPrincipal,
  CurrentTenant,
} from '../../common/decorators/user.decorator';
import type { Principal, TenantContext } from '../../common/types/principal';
import { ApiResponse } from '../../common/utils/api.response';
import { contactDefaults } from '../crm/crm.collections';
import { fieldError, type Row } from '../records/record-store';
import { RecordsService } from '../records/records.service';
import { AutomationService } from './automation.service';
import type { Contact } from './engine/engine';
import { flattenPayload } from './engine/workflow';
import { assertContactCapacity } from '../platform/plan-limits';

const EVENT_NAME = /^[a-z][a-z0-9_.-]{1,63}$/;
const MAX_PROPERTIES_BYTES = 64 * 1024;

interface EventBody {
  event?: unknown;
  contact?: { email?: unknown; phone?: unknown; id?: unknown };
  properties?: unknown;
  occurredAt?: unknown;
}

/**
 * Events API: `POST /events` tracks a named event for one contact and starts
 * "Custom event" automations (docs/API-CONTRACT.md, Phase 10).
 * Authenticate with an API key (`X-Api-Key`) that has `events.write`.
 */
@ApiTags('Events')
@Controller()
@TenantScoped()
export class EventsController {
  constructor(
    private readonly records: RecordsService,
    private readonly automation: AutomationService,
  ) {}

  @Post('events')
  @HttpCode(202)
  @ApiOperation({ summary: 'Track a custom event for a contact' })
  async track(
    @Body() body: EventBody,
    @CurrentTenant() t: TenantContext,
    @CurrentPrincipal() p: Principal,
  ) {
    const event = typeof body?.event === 'string' ? body.event.trim() : '';
    if (!EVENT_NAME.test(event)) {
      throw fieldError(
        422,
        'INVALID_EVENT',
        'event',
        'Use 2–64 lowercase letters, digits, dots, dashes or underscores, starting with a letter (e.g. order.refunded).',
      );
    }
    const who = body.contact ?? {};
    const by = ['id', 'email', 'phone'].find(
      (k) =>
        typeof who[k as keyof typeof who] === 'string' &&
        String(who[k as keyof typeof who]).trim(),
    ) as 'id' | 'email' | 'phone' | undefined;
    if (!by) {
      throw fieldError(
        422,
        'CONTACT_REQUIRED',
        'contact',
        'Identify the contact with contact.email, contact.phone or contact.id.',
      );
    }
    const identifier = String(who[by]).trim();

    const properties =
      body.properties === undefined || body.properties === null
        ? {}
        : body.properties;
    if (typeof properties !== 'object' || Array.isArray(properties)) {
      throw fieldError(
        422,
        'INVALID_PROPERTIES',
        'properties',
        'properties must be a JSON object',
      );
    }
    const payload = JSON.stringify(properties);
    if (Buffer.byteLength(payload) > MAX_PROPERTIES_BYTES) {
      throw fieldError(
        422,
        'PROPERTIES_TOO_LARGE',
        'properties',
        'properties are limited to 64 KB',
      );
    }
    const occurredAt =
      typeof body.occurredAt === 'string' &&
      !Number.isNaN(Date.parse(body.occurredAt))
        ? new Date(body.occurredAt).toISOString()
        : new Date().toISOString();

    const result = await this.records.exec(
      t,
      p,
      'events.write',
      async (ctx) => {
        let contact = await this.automation.findContact(ctx, by, identifier);
        let created = false;
        if (!contact) {
          if (by === 'id') {
            throw fieldError(
              422,
              'CONTACT_NOT_FOUND',
              'contact.id',
              'No contact has this id',
            );
          }
          await assertContactCapacity(ctx, 1);
          contact = await ctx.store.insert<Row & Contact>(
            'contacts',
            contactDefaults({
              [by]: by === 'email' ? identifier.toLowerCase() : identifier,
              source: 'api',
            }),
          );
          created = true;
        }
        await ctx.store.patch('contacts', contact.id, {
          lastActivityAt: occurredAt,
        });
        await ctx.store.insert('activities', {
          contactId: contact.id,
          type: 'event',
          channel: null,
          title: `Event: ${event}`,
          description: payload === '{}' ? '' : payload.slice(0, 500),
          authorName: ctx.actorName,
          at: occurredAt,
        });
        const values: Record<string, string> = {
          event,
          occurred_at: occurredAt,
          payload,
          ...Object.fromEntries(
            flattenPayload(properties as Record<string, unknown>).map(
              ([k, v]) => [`properties.${k}`, v],
            ),
          ),
        };
        const dispatched = await this.automation.fire(ctx, {
          type: 'webhook',
          contactId: contact.id,
          key: event,
          values,
        });
        return {
          event,
          contactId: contact.id,
          contactCreated: created,
          ...dispatched,
        };
      },
    );
    return ApiResponse.success(result, 'Event accepted', 202);
  }
}
