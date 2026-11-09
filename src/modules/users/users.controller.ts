import { Body, Controller, Patch } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { UserOnly } from '../../common/decorators/roles.decorator';
import { CurrentUser, ReqMeta } from '../../common/decorators/user.decorator';
import type { Principal, RequestMeta } from '../../common/types/principal';
import { ApiResponse } from '../../common/utils/api.response';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UsersService } from './users.service';

/** Account-level endpoints. Team membership lives under /tenants/:tenantId/members. */
@ApiTags('Account')
@Controller('users')
@UserOnly()
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Patch('me')
  async updateMe(
    @CurrentUser() user: Extract<Principal, { type: 'user' }>,
    @Body() dto: UpdateProfileDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    return ApiResponse.success(
      await this.usersService.updateProfile(user, dto, meta),
      'Profile updated',
    );
  }
}
