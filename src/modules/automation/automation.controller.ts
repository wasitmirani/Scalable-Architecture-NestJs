import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Put,
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
import { parseListQuery, RecordsService } from '../records/records.service';
import { AutomationService } from './automation.service';

/** Automation actions (docs/API-CONTRACT.md, Phase 10). */
@ApiTags('Automations')
@Controller()
@TenantScoped()
export class AutomationController {
  constructor(
    private readonly records: RecordsService,
    private readonly automation: AutomationService,
  ) {}

  private run<T>(
    tenant: TenantContext,
    principal: Principal,
    permission: string,
    work: (ctx: HookContext) => Promise<T>,
    message?: string,
  ) {
    return this.records
      .exec(tenant, principal, permission, work)
      .then((data) => ApiResponse.success(data, message));
  }

  // A literal path, so it must not fall through to `GET /workflows/:id`.
  @Get('workflows/run-overview')
  overview(
    @CurrentTenant() t: TenantContext,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.run(t, p, 'automations.read', (ctx) =>
      this.automation.overview(ctx),
    );
  }

  /** Saves the draft only; nothing changes for contacts until publish. */
  @Put('workflows/:id')
  save(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentTenant() t: TenantContext,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.run(
      t,
      p,
      'automations.manage',
      (ctx) => this.automation.save(ctx, id, body),
      'Draft saved',
    );
  }

  @Post('workflows/:id/publish')
  @HttpCode(200)
  publish(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { note?: unknown },
    @CurrentTenant() t: TenantContext,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.run(
      t,
      p,
      'automations.publish',
      (ctx) => this.automation.publish(ctx, id, body?.note),
      'Published',
    );
  }

  @Post('workflows/:id/pause')
  @HttpCode(200)
  pause(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() t: TenantContext,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.run(
      t,
      p,
      'automations.publish',
      (ctx) => this.automation.pause(ctx, id),
      'Automation paused',
    );
  }

  @Post('workflows/:id/resume')
  @HttpCode(200)
  resume(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() t: TenantContext,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.run(
      t,
      p,
      'automations.publish',
      (ctx) => this.automation.resume(ctx, id),
      'Automation resumed',
    );
  }

  @Post('workflows/:id/versions/:version/restore')
  @HttpCode(200)
  restore(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('version', ParseIntPipe) version: number,
    @CurrentTenant() t: TenantContext,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.run(
      t,
      p,
      'automations.manage',
      (ctx) => this.automation.restoreVersion(ctx, id, version),
      'Version copied into the draft',
    );
  }

  @Get('workflows/:id/runs')
  workflowRuns(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: Record<string, unknown>,
    @CurrentTenant() t: TenantContext,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.run(t, p, 'automations.read', (ctx) =>
      this.automation.runs(ctx, parseListQuery(q), id),
    );
  }

  @Get('workflows/:id/run-stats')
  stats(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() t: TenantContext,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.run(t, p, 'automations.read', async (ctx) => {
      await this.automation.tick(ctx);
      return this.automation.stats(ctx, id);
    });
  }

  @Post('workflows/:id/test-runs')
  testRun(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { contactId: unknown; draft: unknown },
    @CurrentTenant() t: TenantContext,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.run(t, p, 'automations.manage', (ctx) =>
      this.automation.testRun(ctx, id, body?.contactId, body?.draft),
    );
  }

  @Post('workflows/:id/webhook/test')
  @HttpCode(200)
  testWebhook(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { config: unknown },
    @CurrentTenant() t: TenantContext,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.run(t, p, 'automations.manage', (ctx) =>
      this.automation.testWebhook(ctx, id, body?.config),
    );
  }

  @Get('workflows/:id/webhook/requests')
  webhookRequests(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() t: TenantContext,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.run(t, p, 'automations.read', (ctx) =>
      this.automation.webhookRequests(ctx, id),
    );
  }

  @Get('workflow-runs')
  allRuns(
    @Query() q: Record<string, unknown>,
    @CurrentTenant() t: TenantContext,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.run(t, p, 'automations.read', (ctx) =>
      this.automation.runs(ctx, parseListQuery(q)),
    );
  }

  @Get('workflow-runs/:runId')
  oneRun(
    @Param('runId', ParseUUIDPipe) runId: string,
    @CurrentTenant() t: TenantContext,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.run(t, p, 'automations.read', (ctx) =>
      this.automation.run(ctx, runId),
    );
  }

  @Post('workflow-runs/:runId/retry')
  @HttpCode(200)
  retry(
    @Param('runId', ParseUUIDPipe) runId: string,
    @CurrentTenant() t: TenantContext,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.run(
      t,
      p,
      'automations.publish',
      (ctx) => this.automation.retryRun(ctx, runId),
      'Retrying from the failed step',
    );
  }

  @Post('workflow-runs/:runId/cancel')
  @HttpCode(200)
  cancel(
    @Param('runId', ParseUUIDPipe) runId: string,
    @CurrentTenant() t: TenantContext,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.run(
      t,
      p,
      'automations.publish',
      (ctx) => this.automation.cancelRun(ctx, runId),
      'Run cancelled',
    );
  }
}
