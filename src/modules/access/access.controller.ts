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
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import {
  CurrentPrincipal,
  CurrentTenant,
  ReqMeta,
} from '../../common/decorators/user.decorator';
import type {
  Principal,
  RequestMeta,
  TenantContext,
} from '../../common/types/principal';
import { ApiResponse } from '../../common/utils/api.response';
import { AccessService } from './access.service';
import { CreateRoleDto, UpdateRoleDto } from './dto/role.dto';

@ApiTags('Roles & permissions')
@Controller()
export class AccessController {
  constructor(private readonly access: AccessService) {}

  @Get('permissions')
  async permissions() {
    return ApiResponse.success(
      await this.access.listPermissions(),
      'Permissions fetched',
    );
  }

  @Get('roles')
  @RequirePermissions('roles.read')
  async roles(@CurrentTenant() tenant: TenantContext) {
    return ApiResponse.success(
      await this.access.listRoles(tenant),
      'Roles fetched',
    );
  }

  @Post('roles')
  @RequirePermissions('roles.manage')
  async createRole(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() actor: Principal,
    @Body() dto: CreateRoleDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    return ApiResponse.created(
      await this.access.createRole(tenant, actor, dto, meta),
      'Role created',
    );
  }

  @Patch('roles/:id')
  @RequirePermissions('roles.manage')
  async updateRole(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() actor: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRoleDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    return ApiResponse.success(
      await this.access.updateRole(tenant, actor, id, dto, meta),
      'Role updated',
    );
  }

  @Delete('roles/:id')
  @HttpCode(200)
  @RequirePermissions('roles.manage')
  async deleteRole(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() actor: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    await this.access.deleteRole(tenant, actor, id, meta);
    return ApiResponse.success(null, 'Role deleted');
  }
}
