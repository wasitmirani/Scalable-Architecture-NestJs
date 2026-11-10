import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
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
import { invalidState, text } from '../records/record-store';
import { RecordsService } from '../records/records.service';
import { PLANS, PlatformService } from './platform.service';
import { sendWebhook } from './webhook-sender';

/** Developers, billing, integrations, notifications and analytics (Phase 12+). */
@ApiTags('Platform')
@Controller()
@TenantScoped()
export class PlatformController {
  constructor(
    private readonly records: RecordsService,
    private readonly platform: PlatformService,
  ) {}

  private run<T>(
    tenant: TenantContext,
    principal: Principal,
    permission: string | null,
    work: (ctx: HookContext) => Promise<T>,
    message?: string,
  ) {
    return this.records
      .exec(tenant, principal, permission, work)
      .then((data) => ApiResponse.success(data, message));
  }

  // ---------- Webhooks ----------

  @Get('webhook-deliveries')
  deliveries(
    @Query('endpoint_id') endpointId: string | undefined,
    @CurrentTenant() t: TenantContext,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.run(t, p, 'webhooks.manage', (ctx) =>
      this.platform.deliveries(ctx, endpointId || undefined),
    );
  }

  /** Sends a signed `ping` event to the endpoint for real. */
  @Post('webhook-endpoints/:id/test')
  async test(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() t: TenantContext,
    @CurrentPrincipal() p: Principal,
  ) {
    const endpoint = await this.records.exec(t, p, 'webhooks.manage', (ctx) =>
      ctx.store.find('webhook-endpoints', id),
    );
    if (endpoint.status !== 'active') {
      throw invalidState('Enable the endpoint before sending a test.');
    }
    const requestBody = JSON.stringify(
      {
        type: 'ping',
        createdAt: new Date().toISOString(),
        data: { endpointId: id },
      },
      null,
      2,
    );
    const result = await sendWebhook(
      text(endpoint.url),
      text(endpoint._secret),
      'ping',
      requestBody,
    );
    return this.run(t, p, 'webhooks.manage', (ctx) =>
      this.platform.recordDelivery(ctx, id, {
        event: 'ping',
        attempt: 1,
        requestBody,
        ...result,
      }),
    );
  }

  /** Sends the stored payload again; the attempt counter goes up. */
  @Post('webhook-deliveries/:id/redeliver')
  @HttpCode(200)
  async redeliver(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() t: TenantContext,
    @CurrentPrincipal() p: Principal,
  ) {
    const { delivery, endpoint } = await this.records.exec(
      t,
      p,
      'webhooks.manage',
      async (ctx) => {
        const delivery = await ctx.store.find('webhook-deliveries', id);
        const endpoint = await ctx.store.find(
          'webhook-endpoints',
          text(delivery.endpointId),
        );
        return { delivery, endpoint };
      },
    );
    const result = await sendWebhook(
      text(endpoint.url),
      text(endpoint._secret),
      text(delivery.event),
      text(delivery.requestBody),
    );
    return this.run(t, p, 'webhooks.manage', (ctx) =>
      this.platform.recordDelivery(
        ctx,
        endpoint.id,
        { ...result, attempt: (Number(delivery.attempt) || 1) + 1 },
        id,
      ),
    );
  }

  /** Returns the new secret once; only its prefix is shown afterwards. */
  @Post('webhook-endpoints/:id/rotate-secret')
  @HttpCode(200)
  rotate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() t: TenantContext,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.run(
      t,
      p,
      'webhooks.manage',
      (ctx) => this.platform.rotateSecret(ctx, id),
      'Secret rotated. Copy it now — it will not be shown again.',
    );
  }

  // ---------- Billing ----------

  @Get('billing/plans')
  plans(@CurrentTenant() t: TenantContext, @CurrentPrincipal() p: Principal) {
    return this.run(t, p, null, () => Promise.resolve(PLANS));
  }

  @Get('billing/subscription')
  subscription(
    @CurrentTenant() t: TenantContext,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.run(t, p, 'billing.read', (ctx) =>
      this.platform.subscription(ctx),
    );
  }

  @Post('billing/subscription')
  @HttpCode(200)
  changePlan(
    @Body() body: { planId: unknown; cycle: unknown },
    @CurrentTenant() t: TenantContext,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.run(
      t,
      p,
      'billing.manage',
      (ctx) => this.platform.changePlan(ctx, body?.planId, body?.cycle),
      'Plan updated',
    );
  }

  // ---------- Integrations, notifications, analytics ----------

  @Post('integrations/:id/connect')
  @HttpCode(200)
  connect(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { account: unknown },
    @CurrentTenant() t: TenantContext,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.run(t, p, 'integrations.manage', (ctx) =>
      this.platform.connect(ctx, id, body?.account),
    );
  }

  @Post('integrations/:id/disconnect')
  @HttpCode(200)
  disconnect(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() t: TenantContext,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.run(t, p, 'integrations.manage', (ctx) =>
      this.platform.disconnect(ctx, id),
    );
  }

  @Post('notifications/read-all')
  @HttpCode(200)
  readAll(@CurrentTenant() t: TenantContext, @CurrentPrincipal() p: Principal) {
    return this.run(t, p, null, (ctx) => this.platform.markAllRead(ctx));
  }

  @Get('analytics/overview')
  overview(
    @Query('days') days: string | undefined,
    @CurrentTenant() t: TenantContext,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.run(t, p, null, (ctx) =>
      this.platform.overview(ctx, Number(days ?? 30)),
    );
  }
}
