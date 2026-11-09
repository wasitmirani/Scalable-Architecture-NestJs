import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  RequirePermissions,
  TenantScoped,
  UserOnly,
} from '../../common/decorators/roles.decorator';
import {
  CurrentPrincipal,
  CurrentTenant,
  CurrentUser,
  ReqMeta,
} from '../../common/decorators/user.decorator';
import type {
  Principal,
  RequestMeta,
  TenantContext,
} from '../../common/types/principal';
import { ApiResponse } from '../../common/utils/api.response';
import {
  CreateTenantDto,
  UpdateMemberDto,
  UpdateTenantDto,
  UpdateTenantSettingsDto,
} from './dto/tenant.dto';
import { TenantsService } from './tenants.service';

@ApiTags('Workspaces')
@Controller('tenants')
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @Get()
  @UserOnly()
  async mine(@CurrentUser() user: Extract<Principal, { type: 'user' }>) {
    return ApiResponse.success(
      await this.tenants.listForUser(user.userId),
      'Workspaces fetched',
    );
  }

  @Post()
  @UserOnly()
  async create(
    @CurrentUser() user: Extract<Principal, { type: 'user' }>,
    @Body() dto: CreateTenantDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    return ApiResponse.created(
      await this.tenants.create(user, dto.name, meta),
      'Workspace created',
    );
  }

  @Get(':tenantId')
  @RequirePermissions('tenant.read')
  async get(@CurrentTenant() tenant: TenantContext) {
    return ApiResponse.success(
      await this.tenants.get(tenant),
      'Workspace fetched',
    );
  }

  @Patch(':tenantId')
  @RequirePermissions('tenant.update')
  async update(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() actor: Principal,
    @Body() dto: UpdateTenantDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    return ApiResponse.success(
      await this.tenants.update(tenant, actor, dto, meta),
      'Workspace updated',
    );
  }

  @Get(':tenantId/settings')
  @RequirePermissions('tenant.read')
  async settings(@CurrentTenant() tenant: TenantContext) {
    return ApiResponse.success(
      await this.tenants.getSettings(tenant),
      'Settings fetched',
    );
  }

  @Patch(':tenantId/settings')
  @RequirePermissions('tenant.update')
  async updateSettings(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() actor: Principal,
    @Body() dto: UpdateTenantSettingsDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    return ApiResponse.success(
      await this.tenants.updateSettings(tenant, actor, dto, meta),
      'Settings updated',
    );
  }

  @Get(':tenantId/members')
  @RequirePermissions('members.read')
  async members(@CurrentTenant() tenant: TenantContext) {
    return ApiResponse.success(
      await this.tenants.listMembers(tenant),
      'Members fetched',
    );
  }

  @Patch(':tenantId/members/:memberId')
  @RequirePermissions('members.manage')
  async updateMember(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() actor: Principal,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Body() dto: UpdateMemberDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    return ApiResponse.success(
      await this.tenants.updateMember(tenant, actor, memberId, dto, meta),
      'Member updated',
    );
  }

  @Delete(':tenantId/members/:memberId')
  @HttpCode(200)
  @RequirePermissions('members.manage')
  async removeMember(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() actor: Principal,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    await this.tenants.removeMember(tenant, actor, memberId, meta);
    return ApiResponse.success(null, 'Member removed');
  }

  /** Leave a workspace (any member, except the last owner). */
  @Post(':tenantId/leave')
  @HttpCode(200)
  @UserOnly()
  @TenantScoped()
  async leave(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() actor: Principal,
    @ReqMeta() meta: RequestMeta,
  ) {
    await this.tenants.removeMember(
      tenant,
      actor,
      tenant.memberId as string,
      meta,
    );
    return ApiResponse.success(null, 'You left the workspace');
  }
}
