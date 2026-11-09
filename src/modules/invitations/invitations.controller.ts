import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import {
  RequirePermissions,
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
import { CreateInvitationDto, InvitationTokenDto } from './dto/invitation.dto';
import { InvitationsService } from './invitations.service';

@ApiTags('Invitations')
@Controller('invitations')
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Get()
  @RequirePermissions('members.read')
  async list(@CurrentTenant() tenant: TenantContext) {
    return ApiResponse.success(
      await this.invitations.listPending(tenant),
      'Invitations fetched',
    );
  }

  @Post()
  @RequirePermissions('members.manage')
  async create(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() actor: Principal,
    @Body() dto: CreateInvitationDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    return ApiResponse.created(
      await this.invitations.create(tenant, actor, dto, meta),
      'Invitation sent',
    );
  }

  @Public()
  @Get('preview')
  async preview(@Query() { token }: InvitationTokenDto) {
    return ApiResponse.success(
      await this.invitations.preview(token),
      'Invitation found',
    );
  }

  @Post('accept')
  @HttpCode(200)
  @UserOnly()
  async accept(
    @CurrentUser() user: Extract<Principal, { type: 'user' }>,
    @Body() { token }: InvitationTokenDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    return ApiResponse.success(
      await this.invitations.accept(user, token, meta),
      'Invitation accepted',
    );
  }

  @Post(':id/resend')
  @HttpCode(200)
  @RequirePermissions('members.manage')
  async resend(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() actor: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    await this.invitations.resend(tenant, actor, id, meta);
    return ApiResponse.success(null, 'Invitation resent');
  }

  @Delete(':id')
  @HttpCode(200)
  @RequirePermissions('members.manage')
  async revoke(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() actor: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    await this.invitations.revoke(tenant, actor, id, meta);
    return ApiResponse.success(null, 'Invitation revoked');
  }
}
