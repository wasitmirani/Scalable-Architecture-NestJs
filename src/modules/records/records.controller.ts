import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { NotFoundException } from '../../common/exceptions/custom.exceptions';
import { TenantScoped } from '../../common/decorators/roles.decorator';
import {
  CurrentPrincipal,
  CurrentTenant,
} from '../../common/decorators/user.decorator';
import type { Principal, TenantContext } from '../../common/types/principal';
import { ApiResponse } from '../../common/utils/api.response';
import { parseListQuery, RecordsService } from './records.service';

/**
 * Standard REST resources of the product modules (docs/API-CONTRACT.md):
 * `GET /x`, `GET /x/:id`, `POST /x`, `PATCH /x/:id`, `DELETE /x/:id` for every
 * collection in collections.registry.ts. Registered after the module controllers,
 * so their specific routes (`/contacts/bulk-update`…) match first.
 * Permissions are per collection, checked here rather than by decorator.
 */
@ApiExcludeController()
@Controller()
@TenantScoped()
export class RecordsController {
  constructor(private readonly records: RecordsService) {}

  private target(path: string | string[]) {
    const joined = Array.isArray(path) ? path.join('/') : path;
    const found = this.records.resolve(joined);
    if (!found) throw new NotFoundException('Route');
    return found;
  }

  @Get('*path')
  async read(
    @Param('path') path: string | string[],
    @Query() query: Record<string, unknown>,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    const { def, id } = this.target(path);
    this.records.assertCan(tenant, def.read);
    const actor = await this.records.actorName(principal);
    return ApiResponse.success(
      await this.records.run<unknown>(tenant, actor, (ctx) =>
        id
          ? this.records.get(ctx, def, id)
          : this.records.list(ctx, def, parseListQuery(query)),
      ),
    );
  }

  @Post('*path')
  async create(
    @Param('path') path: string | string[],
    @Body() body: unknown,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    const { def, id } = this.target(path);
    if (id) throw new NotFoundException('Route');
    this.records.assertCan(tenant, def.write);
    const actor = await this.records.actorName(principal);
    return ApiResponse.success(
      await this.records.run(tenant, actor, (ctx) =>
        this.records.create(ctx, def, body),
      ),
      'Created',
      201,
    );
  }

  @Patch('*path')
  async update(
    @Param('path') path: string | string[],
    @Body() body: unknown,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    const { def, id } = this.target(path);
    if (!id) throw new NotFoundException('Route');
    this.records.assertCan(tenant, def.write);
    const actor = await this.records.actorName(principal);
    return ApiResponse.success(
      await this.records.run(tenant, actor, (ctx) =>
        this.records.update(ctx, def, id, body),
      ),
      'Updated',
    );
  }

  @Delete('*path')
  @HttpCode(200)
  async remove(
    @Param('path') path: string | string[],
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    const { def, id } = this.target(path);
    if (!id) throw new NotFoundException('Route');
    this.records.assertCan(tenant, def.write);
    const actor = await this.records.actorName(principal);
    await this.records.run(tenant, actor, (ctx) =>
      this.records.remove(ctx, def, id),
    );
    return ApiResponse.success(null, 'Deleted');
  }
}
