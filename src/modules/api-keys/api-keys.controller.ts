import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
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
import { ApiKeysService } from './api-keys.service';
import { CreateApiKeyDto } from './dto/api-key.dto';

@ApiTags('API keys')
@Controller('api-keys')
export class ApiKeysController {
  constructor(private readonly apiKeys: ApiKeysService) {}

  @Get()
  @RequirePermissions('api_keys.read')
  async list(@CurrentTenant() tenant: TenantContext) {
    return ApiResponse.success(
      await this.apiKeys.list(tenant),
      'API keys fetched',
    );
  }

  @Post()
  @RequirePermissions('api_keys.manage')
  async create(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() actor: Principal,
    @Body() dto: CreateApiKeyDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    return ApiResponse.created(
      await this.apiKeys.create(tenant, actor, dto, meta),
      'API key created. Copy it now — it will not be shown again.',
    );
  }

  @Post(':id/rotate')
  @HttpCode(200)
  @RequirePermissions('api_keys.manage')
  async rotate(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() actor: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    return ApiResponse.success(
      await this.apiKeys.rotate(tenant, actor, id, meta),
      'API key rotated. Copy it now — it will not be shown again.',
    );
  }

  @Delete(':id')
  @HttpCode(200)
  @RequirePermissions('api_keys.manage')
  async revoke(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() actor: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    await this.apiKeys.revoke(tenant, actor, id, meta);
    return ApiResponse.success(null, 'API key revoked');
  }
}
