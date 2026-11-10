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
import { parseListQuery, RecordsService } from '../records/records.service';
import {
  CrmService,
  type BulkUpdateBody,
  type ImportBody,
} from './crm.service';

/** CRM actions beyond the standard resources (docs/API-CONTRACT.md, Phase 3). */
@ApiTags('CRM')
@Controller()
@TenantScoped()
export class CrmController {
  constructor(
    private readonly records: RecordsService,
    private readonly crm: CrmService,
  ) {}

  @Get('contacts')
  async list(
    @Query() query: Record<string, unknown>,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return ApiResponse.success(
      await this.records.exec(tenant, principal, 'contacts.read', (ctx) =>
        this.crm.listContacts(ctx, parseListQuery(query)),
      ),
    );
  }

  @Post('contacts/bulk-update')
  @HttpCode(200)
  async bulkUpdate(
    @Body() body: BulkUpdateBody,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return ApiResponse.success(
      await this.records.exec(tenant, principal, 'contacts.manage', (ctx) =>
        this.crm.bulkUpdate(ctx, body),
      ),
      'Contacts updated',
    );
  }

  @Post('contacts/bulk-delete')
  @HttpCode(200)
  async bulkDelete(
    @Body() body: { ids: string[] },
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return ApiResponse.success(
      await this.records.exec(tenant, principal, 'contacts.manage', (ctx) =>
        this.crm.bulkDelete(ctx, body),
      ),
      'Contacts deleted',
    );
  }

  /** Synchronous for now: returns the matching rows; the UI builds the CSV. */
  @Post('contacts/exports')
  @HttpCode(200)
  async export(
    @Body() body: Record<string, unknown>,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return ApiResponse.success(
      await this.records.exec(tenant, principal, 'contacts.export', (ctx) =>
        this.crm.exportContacts(ctx, parseListQuery(body ?? {})),
      ),
    );
  }

  @Post('contacts/imports')
  async import(
    @Body() body: ImportBody,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return ApiResponse.success(
      await this.records.exec(tenant, principal, 'contacts.import', (ctx) =>
        this.crm.import(ctx, body),
      ),
      'Import finished',
      201,
    );
  }

  @Get('contacts/:id/activities')
  async activities(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return ApiResponse.success(
      await this.records.exec(tenant, principal, 'contacts.read', (ctx) =>
        this.crm.activities(ctx, id),
      ),
    );
  }

  @Post('contacts/:id/notes')
  async addNote(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { text: string },
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return ApiResponse.success(
      await this.records.exec(tenant, principal, 'contacts.manage', (ctx) =>
        this.crm.addNote(ctx, id, body?.text),
      ),
      'Note added',
      201,
    );
  }

  @Post('segments/preview')
  @HttpCode(200)
  async preview(
    @Body() body: { rules: unknown },
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return ApiResponse.success(
      await this.records.exec(tenant, principal, 'contacts.read', (ctx) =>
        this.crm.previewSegment(ctx, body?.rules),
      ),
    );
  }
}
