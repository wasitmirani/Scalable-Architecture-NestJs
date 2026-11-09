import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { CurrentTenant } from '../../common/decorators/user.decorator';
import { CursorQueryDto } from '../../common/pagination/cursor';
import type { TenantContext } from '../../common/types/principal';
import { ApiResponse } from '../../common/utils/api.response';
import { AuditService } from './audit.service';

class AuditQueryDto extends CursorQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  action?: string;
}

@ApiTags('Audit')
@Controller('audit-logs')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequirePermissions('audit.read')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query() query: AuditQueryDto,
  ) {
    return ApiResponse.success(
      await this.audit.list(tenant, query),
      'Audit log fetched',
    );
  }
}
