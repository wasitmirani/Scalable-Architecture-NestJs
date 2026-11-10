import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { TenantDb } from '../../database/database.module';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '../../common/exceptions/custom.exceptions';
import type {
  Principal,
  RequestMeta,
  TenantContext,
} from '../../common/types/principal';
import { Helpers } from '../../common/utils/helpers';
import { randomToken } from '../../common/utils/tokens';
import { AccessService } from '../access/access.service';
import { OWNER_ROLE_KEY } from '../access/entities/role.entity';
import { AuditService } from '../audit/audit.service';
import {
  UpdateMemberDto,
  UpdateTenantDto,
  UpdateTenantSettingsDto,
} from './dto/tenant.dto';
import { Tenant } from './entities/tenant.entity';
import { TenantMember } from './entities/tenant-member.entity';
import { TenantSettings } from './entities/tenant-settings.entity';
import { assertCanCreateWorkspace } from './workspace-limits';

export interface Membership {
  memberId: string;
  tenant: { id: string; name: string; slug: string; status: string };
  role: { id: string; key: string; name: string };
  permissions: string[];
}

export interface MemberView {
  id: string;
  status: string;
  joinedAt: Date;
  user: { id: string; name: string; email: string; avatarUrl: string | null };
  role: { id: string; key: string; name: string };
}

@Injectable()
export class TenantsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantDb: TenantDb,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  /** All workspaces the user belongs to, with their role and permissions in each. */
  async listForUser(userId: string): Promise<Membership[]> {
    const rows = await this.dataSource.query<
      Array<{
        member_id: string;
        tenant_id: string;
        tenant_name: string;
        slug: string;
        tenant_status: string;
        role_id: string;
        role_key: string;
        role_name: string;
        permissions: string[];
      }>
    >(
      `SELECT m.id AS member_id, t.id AS tenant_id, t.name AS tenant_name, t.slug, t.status AS tenant_status,
              r.id AS role_id, r.key AS role_key, r.name AS role_name,
              COALESCE(array_agg(rp.permission_key ORDER BY rp.permission_key)
                       FILTER (WHERE rp.permission_key IS NOT NULL), '{}') AS permissions
         FROM tenant_members m
         JOIN tenants t ON t.id = m.tenant_id
         JOIN roles r ON r.id = m.role_id
         LEFT JOIN role_permissions rp ON rp.role_id = r.id
        WHERE m.user_id = $1 AND m.status = 'active'
        GROUP BY m.id, t.id, r.id
        ORDER BY t.name`,
      [userId],
    );
    return rows.map((r) => ({
      memberId: r.member_id,
      tenant: {
        id: r.tenant_id,
        name: r.tenant_name,
        slug: r.slug,
        status: r.tenant_status,
      },
      role: { id: r.role_id, key: r.role_key, name: r.role_name },
      permissions: r.permissions,
    }));
  }

  /** Creates a workspace with `userId` as its owner. Runs in the caller's (system) transaction. */
  async createWithOwner(
    em: EntityManager,
    userId: string,
    name: string,
  ): Promise<Tenant> {
    const base = Helpers.generateSlug(name).slice(0, 60) || 'workspace';
    const slug = `${base}-${
      randomToken(6)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .slice(0, 6) || 'ws'
    }`;
    const tenant = em.create(Tenant, {
      name,
      slug,
      createdBy: userId,
      status: 'active',
    });
    await em.save(tenant);
    await em.insert(TenantSettings, { tenantId: tenant.id });

    const [owner] = await em.query<Array<{ id: string }>>(
      `SELECT id FROM roles WHERE key = $1 AND tenant_id IS NULL`,
      [OWNER_ROLE_KEY],
    );
    await em.insert(TenantMember, {
      tenantId: tenant.id,
      userId,
      roleId: owner.id,
    });
    return tenant;
  }

  async create(
    actor: Extract<Principal, { type: 'user' }>,
    name: string,
    meta: RequestMeta,
  ) {
    return this.dataSource.transaction(async (em) => {
      // Lock the user so two simultaneous requests cannot both pass the limit check.
      await em.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [actor.userId]);
      await assertCanCreateWorkspace(em, actor.userId);
      const tenant = await this.createWithOwner(em, actor.userId, name);
      await this.audit.record(
        {
          tenantId: tenant.id,
          actor,
          action: 'tenant.created',
          targetType: 'tenant',
          targetId: tenant.id,
        },
        meta,
        em,
      );
      return tenant;
    });
  }

  get(tenant: TenantContext): Promise<Tenant> {
    return this.tenantDb.run(tenant.tenantId, (em) =>
      em.findOneOrFail(Tenant, { where: { id: tenant.tenantId } }),
    );
  }

  update(
    tenant: TenantContext,
    actor: Principal,
    dto: UpdateTenantDto,
    meta: RequestMeta,
  ): Promise<Tenant> {
    return this.tenantDb.run(tenant.tenantId, async (em) => {
      await em.update(Tenant, { id: tenant.tenantId }, { name: dto.name });
      await this.audit.record(
        {
          tenantId: tenant.tenantId,
          actor,
          action: 'tenant.updated',
          targetType: 'tenant',
          targetId: tenant.tenantId,
          metadata: { name: dto.name },
        },
        meta,
        em,
      );
      return em.findOneOrFail(Tenant, { where: { id: tenant.tenantId } });
    });
  }

  getSettings(tenant: TenantContext): Promise<TenantSettings> {
    return this.tenantDb.run(tenant.tenantId, (em) =>
      em.findOneOrFail(TenantSettings, {
        where: { tenantId: tenant.tenantId },
      }),
    );
  }

  updateSettings(
    tenant: TenantContext,
    actor: Principal,
    dto: UpdateTenantSettingsDto,
    meta: RequestMeta,
  ) {
    return this.tenantDb.run(tenant.tenantId, async (em) => {
      if (dto.timezone !== undefined || dto.locale !== undefined) {
        await em.update(
          TenantSettings,
          { tenantId: tenant.tenantId },
          {
            ...(dto.timezone !== undefined && { timezone: dto.timezone }),
            ...(dto.locale !== undefined && { locale: dto.locale }),
          },
        );
        await this.audit.record(
          {
            tenantId: tenant.tenantId,
            actor,
            action: 'tenant.settings_updated',
            targetType: 'tenant',
            targetId: tenant.tenantId,
            metadata: { ...dto },
          },
          meta,
          em,
        );
      }
      return em.findOneOrFail(TenantSettings, {
        where: { tenantId: tenant.tenantId },
      });
    });
  }

  listMembers(tenant: TenantContext): Promise<MemberView[]> {
    return this.tenantDb.run(tenant.tenantId, (em) =>
      this.queryMembers(em, tenant.tenantId),
    );
  }

  async updateMember(
    tenant: TenantContext,
    actor: Principal,
    memberId: string,
    dto: UpdateMemberDto,
    meta: RequestMeta,
  ) {
    if (!dto.roleId && !dto.status) {
      throw new BadRequestException(
        'Provide roleId and/or status',
        'NOTHING_TO_UPDATE',
      );
    }
    return this.tenantDb.run(tenant.tenantId, async (em) => {
      const member = await this.findMember(em, tenant.tenantId, memberId);
      const newRole = dto.roleId
        ? await this.access.getAssignableRole(em, tenant, dto.roleId)
        : null;

      const losesOwner =
        member.role.key === OWNER_ROLE_KEY &&
        ((newRole && newRole.key !== OWNER_ROLE_KEY) ||
          dto.status === 'suspended');
      if (
        member.role.key === OWNER_ROLE_KEY &&
        tenant.roleKey !== OWNER_ROLE_KEY
      ) {
        throw new ForbiddenException(
          'Only owners can change another owner',
          'OWNER_ONLY',
        );
      }
      if (losesOwner)
        await this.assertAnotherOwner(em, tenant.tenantId, member.id);

      await em.update(
        TenantMember,
        { id: member.id, tenantId: tenant.tenantId },
        {
          ...(newRole && { roleId: newRole.id }),
          ...(dto.status && { status: dto.status }),
        },
      );
      await this.audit.record(
        {
          tenantId: tenant.tenantId,
          actor,
          action: 'member.updated',
          targetType: 'member',
          targetId: member.id,
          metadata: {
            userId: member.user.id,
            ...(newRole && { role: newRole.key }),
            ...(dto.status && { status: dto.status }),
          },
        },
        meta,
        em,
      );
      const [updated] = await this.queryMembers(em, tenant.tenantId, member.id);
      return updated;
    });
  }

  async removeMember(
    tenant: TenantContext,
    actor: Principal,
    memberId: string,
    meta: RequestMeta,
  ) {
    await this.tenantDb.run(tenant.tenantId, async (em) => {
      const member = await this.findMember(em, tenant.tenantId, memberId);
      const isSelf = member.id === tenant.memberId;
      if (
        member.role.key === OWNER_ROLE_KEY &&
        !isSelf &&
        tenant.roleKey !== OWNER_ROLE_KEY
      ) {
        throw new ForbiddenException(
          'Only owners can remove another owner',
          'OWNER_ONLY',
        );
      }
      if (member.role.key === OWNER_ROLE_KEY)
        await this.assertAnotherOwner(em, tenant.tenantId, member.id);

      await em.delete(TenantMember, {
        id: member.id,
        tenantId: tenant.tenantId,
      });
      await this.audit.record(
        {
          tenantId: tenant.tenantId,
          actor,
          action: isSelf ? 'member.left' : 'member.removed',
          targetType: 'member',
          targetId: member.id,
          metadata: { userId: member.user.id },
        },
        meta,
        em,
      );
    });
  }

  /** Adds a member inside the caller's transaction (used when accepting invitations). */
  async addMember(
    em: EntityManager,
    input: {
      tenantId: string;
      userId: string;
      roleId: string;
      invitedBy: string | null;
    },
  ) {
    const exists = await em.exists(TenantMember, {
      where: { tenantId: input.tenantId, userId: input.userId },
    });
    if (exists)
      throw new ConflictException(
        'You are already a member of this workspace',
        'ALREADY_MEMBER',
      );
    const { identifiers } = await em.insert(TenantMember, input);
    return identifiers[0].id as string;
  }

  private async findMember(
    em: EntityManager,
    tenantId: string,
    memberId: string,
  ): Promise<MemberView> {
    const [member] = await this.queryMembers(em, tenantId, memberId);
    if (!member) throw new NotFoundException('Member');
    return member;
  }

  private async assertAnotherOwner(
    em: EntityManager,
    tenantId: string,
    excludingMemberId: string,
  ) {
    const [{ count }] = await em.query<Array<{ count: string }>>(
      `SELECT count(*) FROM tenant_members m JOIN roles r ON r.id = m.role_id
        WHERE m.tenant_id = $1 AND r.key = $2 AND m.status = 'active' AND m.id <> $3`,
      [tenantId, OWNER_ROLE_KEY, excludingMemberId],
    );
    if (Number(count) === 0) {
      throw new BadRequestException(
        'A workspace must keep at least one active owner',
        'LAST_OWNER',
      );
    }
  }

  private async queryMembers(
    em: EntityManager,
    tenantId: string,
    memberId?: string,
  ): Promise<MemberView[]> {
    const rows = await em.query<
      Array<{
        id: string;
        status: string;
        joined_at: Date;
        user_id: string;
        name: string;
        email: string;
        avatar_url: string | null;
        role_id: string;
        role_key: string;
        role_name: string;
      }>
    >(
      `SELECT m.id, m.status, m.joined_at, u.id AS user_id, u.name, u.email, u.avatar_url,
              r.id AS role_id, r.key AS role_key, r.name AS role_name
         FROM tenant_members m
         JOIN users u ON u.id = m.user_id
         JOIN roles r ON r.id = m.role_id
        WHERE m.tenant_id = $1 AND ($2::uuid IS NULL OR m.id = $2::uuid)
        ORDER BY m.joined_at`,
      [tenantId, memberId ?? null],
    );
    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      joinedAt: r.joined_at,
      user: {
        id: r.user_id,
        name: r.name,
        email: r.email,
        avatarUrl: r.avatar_url,
      },
      role: { id: r.role_id, key: r.role_key, name: r.role_name },
    }));
  }
}
