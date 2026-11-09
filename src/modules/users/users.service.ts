import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { Principal, RequestMeta } from '../../common/types/principal';
import { AuditService } from '../audit/audit.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { toPublicUser, User } from './entities/user.entity';

@Injectable()
export class UsersService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  async updateProfile(
    user: Extract<Principal, { type: 'user' }>,
    dto: UpdateProfileDto,
    meta: RequestMeta,
  ) {
    return this.dataSource.transaction(async (em) => {
      await em.update(User, { id: user.userId }, { name: dto.name });
      await this.audit.record(
        {
          tenantId: null,
          actor: user,
          action: 'user.profile_updated',
          targetType: 'user',
          targetId: user.userId,
        },
        meta,
        em,
      );
      return toPublicUser(await em.findOneByOrFail(User, { id: user.userId }));
    });
  }
}
