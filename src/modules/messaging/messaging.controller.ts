import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
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
import { text } from '../records/record-store';
import { RecordsService } from '../records/records.service';
import { MessagingService, providerNotConnected } from './messaging.service';

/** Campaigns, templates, message log and brand kit actions (Phases 4–9). */
@ApiTags('Messaging')
@Controller()
@TenantScoped()
export class MessagingController {
  constructor(
    private readonly records: RecordsService,
    private readonly messaging: MessagingService,
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

  @Post('campaigns/audience-estimate')
  @HttpCode(200)
  estimate(
    @Body() body: { audience: unknown; channel: string },
    @CurrentTenant() t: TenantContext,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.run(t, p, 'campaigns.read', (ctx) =>
      this.messaging.estimate(ctx, body?.audience, text(body?.channel)),
    );
  }

  @Post('campaigns/:id/launch')
  @HttpCode(200)
  launch(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() t: TenantContext,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.run(
      t,
      p,
      'campaigns.send',
      (ctx) => this.messaging.launch(ctx, id),
      'Campaign launched',
    );
  }

  @Post('campaigns/:id/pause')
  @HttpCode(200)
  pause(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() t: TenantContext,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.run(t, p, 'campaigns.send', (ctx) =>
      this.messaging.pause(ctx, id),
    );
  }

  @Post('campaigns/:id/resume')
  @HttpCode(200)
  resume(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() t: TenantContext,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.run(t, p, 'campaigns.send', (ctx) =>
      this.messaging.resume(ctx, id),
    );
  }

  @Post('campaigns/:id/cancel')
  @HttpCode(200)
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() t: TenantContext,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.run(t, p, 'campaigns.send', (ctx) =>
      this.messaging.cancel(ctx, id),
    );
  }

  @Post('campaigns/:id/unschedule')
  @HttpCode(200)
  unschedule(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() t: TenantContext,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.run(t, p, 'campaigns.send', (ctx) =>
      this.messaging.unschedule(ctx, id),
    );
  }

  @Post('campaigns/:id/duplicate')
  duplicate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() t: TenantContext,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.run(t, p, 'campaigns.manage', (ctx) =>
      this.messaging.duplicateCampaign(ctx, id),
    );
  }

  @Post('campaigns/:id/test')
  @HttpCode(200)
  testCampaign(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() t: TenantContext,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.run(t, p, 'campaigns.send', async (ctx) => {
      const campaign = await ctx.store.find('campaigns', id);
      throw providerNotConnected(text(campaign.channel) || 'messages');
    });
  }

  @Post('templates/:id/duplicate')
  duplicateTemplate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() t: TenantContext,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.run(t, p, 'templates.manage', (ctx) =>
      this.messaging.duplicateTemplate(ctx, id),
    );
  }

  @Post('templates/:id/submit')
  @HttpCode(200)
  submit(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() t: TenantContext,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.run(
      t,
      p,
      'templates.manage',
      (ctx) => this.messaging.submitTemplate(ctx, id),
      'Submitted for approval',
    );
  }

  @Post('templates/:id/test')
  @HttpCode(200)
  testTemplate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() t: TenantContext,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.run(t, p, 'templates.manage', async (ctx) => {
      const template = await ctx.store.find('templates', id);
      throw providerNotConnected(text(template.channel) || 'messages');
    });
  }

  @Post('messages/:id/retry')
  @HttpCode(200)
  retry(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() t: TenantContext,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.run(
      t,
      p,
      'channels.manage',
      (ctx) => this.messaging.retryMessage(ctx, id),
      'Message queued again',
    );
  }

  @Get('brand-kit')
  brandKit(
    @CurrentTenant() t: TenantContext,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.run(t, p, null, (ctx) => this.messaging.brandKit(ctx));
  }

  @Put('brand-kit')
  updateBrandKit(
    @Body() body: unknown,
    @CurrentTenant() t: TenantContext,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.run(
      t,
      p,
      'templates.manage',
      (ctx) => this.messaging.updateBrandKit(ctx, body),
      'Brand kit saved',
    );
  }
}
