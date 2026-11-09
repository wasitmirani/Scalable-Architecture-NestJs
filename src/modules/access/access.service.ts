import { Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { DataSource, EntityManager, In } from 'typeorm';
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
import { AuditService } from '../audit/audit.service';
import { CreateRoleDto, UpdateRoleDto } from './dto/role.dto';
import { Permission } from './entities/permission.entity';
import { OWNER_ROLE_KEY, Role } from './entities/role.entity';
import { RolePermission } from './entities/role-permission.entity';

export interface RoleWithPermissions {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: string[];
}

/** A principal can only grant permissions it holds itself. */
export function assertGrantable(
  tenant: TenantContext,
  permissions: string[],
): void {
  const missing = permissions.filter((p) => !tenant.permissions.has(p));
  if (missing.length > 0) {
    throw new ForbiddenException(
      `Cannot grant permissions you do not have: ${missing.join(', ')}`,
      'PERMISSION_ESCALATION',
    );
  }
}

@Injectable()
export class AccessService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
  ) {}

  /**
   * Verifies the principal may act in `requestedTenantId` and returns its permissions there.
   * API keys are bound to one tenant; users must hold an active membership.
   */
  async resolveTenantContext(
    principal: Principal,
    requestedTenantId?: string,
  ): Promise<TenantContext> {
    if (requestedTenantId !== undefined && !isUUID(requestedTenantId)) {
      throw new BadRequestException(
        'Tenant id must be a UUID',
        'INVALID_TENANT_ID',
      );
    }

    if (principal.type === 'api_key') {
      if (requestedTenantId && requestedTenantId !== principal.tenantId) {
        throw new ForbiddenException(
          'API key does not belong to this workspace',
          'TENANT_MISMATCH',
        );
      }
      return {
        tenantId: principal.tenantId,
        memberId: null,
        roleKey: null,
        permissions: new Set(principal.scopes),
      };
    }

    if (!requestedTenantId) {
      throw new BadRequestException(
        'X-Tenant-Id header is required',
        'TENANT_REQUIRED',
      );
    }

    const [row] = await this.dataSource.query<
      Array<{
        member_id: string;
        member_status: string;
        tenant_status: string;
        role_key: string;
        permissions: string[];
      }>
    >(
      `SELECT m.id AS member_id, m.status AS member_status, t.status AS tenant_status, r.key AS role_key,
              COALESCE(array_agg(rp.permission_key) FILTER (WHERE rp.permission_key IS NOT NULL), '{}') AS permissions
         FROM tenant_members m
         JOIN tenants t ON t.id = m.tenant_id
         JOIN roles r ON r.id = m.role_id
         LEFT JOIN role_permissions rp ON rp.role_id = r.id
        WHERE m.tenant_id = $1 AND m.user_id = $2
        GROUP BY m.id, t.status, r.key`,
      [requestedTenantId, principal.userId],
    );

    if (!row)
      throw new ForbiddenException(
        'You are not a member of this workspace',
        'NOT_A_MEMBER',
      );
    if (row.tenant_status !== 'active') {
      throw new ForbiddenException(
        'This workspace is suspended',
        'TENANT_SUSPENDED',
      );
    }
    if (row.member_status !== 'active') {
      throw new ForbiddenException(
        'Your membership is suspended',
        'MEMBERSHIP_SUSPENDED',
      );
    }

    return {
      tenantId: requestedTenantId,
      memberId: row.member_id,
      roleKey: row.role_key,
      permissions: new Set(row.permissions),
    };
  }

  listPermissions(): Promise<Permission[]> {
    return this.dataSource
      .getRepository(Permission)
      .find({ order: { category: 'ASC', key: 'ASC' } });
  }

  listRoles(tenant: TenantContext): Promise<RoleWithPermissions[]> {
    return this.tenantDb.run(tenant.tenantId, (em) =>
      this.queryRoles(em, tenant.tenantId),
    );
  }

  /**
   * Loads a role the tenant may assign (system or its own custom role) and checks
   * that the caller may hand it out. Only owners may assign the owner role.
   */
  async getAssignableRole(
    em: EntityManager,
    tenant: TenantContext,
    roleId: string,
  ): Promise<RoleWithPermissions> {
    const [role] = await this.queryRoles(em, tenant.tenantId, roleId);
    if (!role) throw new NotFoundException('Role');
    if (role.key === OWNER_ROLE_KEY && tenant.roleKey !== OWNER_ROLE_KEY) {
      throw new ForbiddenException(
        'Only owners can assign the owner role',
        'OWNER_ONLY',
      );
    }
    assertGrantable(tenant, role.permissions);
    return role;
  }

  async createRole(
    tenant: TenantContext,
    actor: Principal,
    dto: CreateRoleDto,
    meta: RequestMeta,
  ) {
    await this.assertKnownPermissions(dto.permissions);
    assertGrantable(tenant, dto.permissions);
    const key = Helpers.generateSlug(dto.name).replace(/-/g, '_').slice(0, 50);
    if (!key)
      throw new BadRequestException(
        'Role name must contain letters or numbers',
        'INVALID_ROLE_NAME',
      );

    return this.tenantDb.run(tenant.tenantId, async (em) => {
      const taken = await em.exists(Role, {
        where: [{ key, tenantId: tenant.tenantId }],
      });
      const system = await em.query<unknown[]>(
        `SELECT 1 FROM roles WHERE key = $1 AND tenant_id IS NULL`,
        [key],
      );
      if (taken || system.length > 0)
        throw new ConflictException(
          'A role with this name already exists',
          'ROLE_EXISTS',
        );

      const { identifiers } = await em.insert(Role, {
        tenantId: tenant.tenantId,
        key,
        name: dto.name,
        description: dto.description ?? null,
        isSystem: false,
      });
      const roleId = identifiers[0].id as string;
      await this.replacePermissions(
        em,
        tenant.tenantId,
        roleId,
        dto.permissions,
      );
      await this.audit.record(
        {
          tenantId: tenant.tenantId,
          actor,
          action: 'role.created',
          targetType: 'role',
          targetId: roleId,
          metadata: { key, permissions: dto.permissions },
        },
        meta,
        em,
      );
      const [role] = await this.queryRoles(em, tenant.tenantId, roleId);
      return role;
    });
  }

  async updateRole(
    tenant: TenantContext,
    actor: Principal,
    roleId: string,
    dto: UpdateRoleDto,
    meta: RequestMeta,
  ) {
    if (dto.permissions) {
      await this.assertKnownPermissions(dto.permissions);
      assertGrantable(tenant, dto.permissions);
    }
    return this.tenantDb.run(tenant.tenantId, async (em) => {
      const role = await this.findCustomRole(em, tenant.tenantId, roleId);
      if (dto.name !== undefined || dto.description !== undefined) {
        await em.update(
          Role,
          { id: role.id, tenantId: tenant.tenantId },
          {
            ...(dto.name !== undefined && { name: dto.name }),
            ...(dto.description !== undefined && {
              description: dto.description,
            }),
          },
        );
      }
      if (dto.permissions)
        await this.replacePermissions(
          em,
          tenant.tenantId,
          role.id,
          dto.permissions,
        );
      await this.audit.record(
        {
          tenantId: tenant.tenantId,
          actor,
          action: 'role.updated',
          targetType: 'role',
          targetId: role.id,
          metadata: { ...dto },
        },
        meta,
        em,
      );
      const [updated] = await this.queryRoles(em, tenant.tenantId, role.id);
      return updated;
    });
  }

  async deleteRole(
    tenant: TenantContext,
    actor: Principal,
    roleId: string,
    meta: RequestMeta,
  ) {
    await this.tenantDb.run(tenant.tenantId, async (em) => {
      const role = await this.findCustomRole(em, tenant.tenantId, roleId);
      const [{ in_use }] = await em.query<Array<{ in_use: boolean }>>(
        `SELECT EXISTS (SELECT 1 FROM tenant_members WHERE tenant_id = $1 AND role_id = $2)
             OR EXISTS (SELECT 1 FROM invitations WHERE tenant_id = $1 AND role_id = $2
                          AND accepted_at IS NULL AND revoked_at IS NULL) AS in_use`,
        [tenant.tenantId, role.id],
      );
      if (in_use) {
        throw new ConflictException(
          'Role is assigned to members or pending invitations',
          'ROLE_IN_USE',
        );
      }
      await em.delete(Role, { id: role.id, tenantId: tenant.tenantId });
      await this.audit.record(
        {
          tenantId: tenant.tenantId,
          actor,
          action: 'role.deleted',
          targetType: 'role',
          targetId: role.id,
          metadata: { key: role.key },
        },
        meta,
        em,
      );
    });
  }

  private async findCustomRole(
    em: EntityManager,
    tenantId: string,
    roleId: string,
  ): Promise<Role> {
    const role = await em.findOne(Role, { where: { id: roleId } });
    if (!role || (role.tenantId !== null && role.tenantId !== tenantId))
      throw new NotFoundException('Role');
    if (role.isSystem)
      throw new ForbiddenException(
        'System roles cannot be changed',
        'SYSTEM_ROLE_READONLY',
      );
    return role;
  }

  private async replacePermissions(
    em: EntityManager,
    tenantId: string,
    roleId: string,
    permissions: string[],
  ) {
    await em.delete(RolePermission, { roleId, tenantId });
    const unique = [...new Set(permissions)];
    if (unique.length > 0) {
      await em.insert(
        RolePermission,
        unique.map((permissionKey) => ({ roleId, permissionKey, tenantId })),
      );
    }
  }

  private async assertKnownPermissions(permissions: string[]) {
    const unique = [...new Set(permissions)];
    const known = await this.dataSource
      .getRepository(Permission)
      .countBy({ key: In(unique) });
    if (known !== unique.length)
      throw new BadRequestException('Unknown permission', 'UNKNOWN_PERMISSION');
  }

  private async queryRoles(
    em: EntityManager,
    tenantId: string,
    roleId?: string,
  ): Promise<RoleWithPermissions[]> {
    const rows = await em.query<
      Array<{
        id: string;
        key: string;
        name: string;
        description: string | null;
        is_system: boolean;
        permissions: string[];
      }>
    >(
      `SELECT r.id, r.key, r.name, r.description, r.is_system,
              COALESCE(array_agg(rp.permission_key ORDER BY rp.permission_key)
                       FILTER (WHERE rp.permission_key IS NOT NULL), '{}') AS permissions
         FROM roles r
         LEFT JOIN role_permissions rp ON rp.role_id = r.id
        WHERE (r.tenant_id IS NULL OR r.tenant_id = $1) AND ($2::uuid IS NULL OR r.id = $2::uuid)
        GROUP BY r.id
        ORDER BY r.is_system DESC, r.name`,
      [tenantId, roleId ?? null],
    );
    return rows.map((r) => ({
      id: r.id,
      key: r.key,
      name: r.name,
      description: r.description,
      isSystem: r.is_system,
      permissions: r.permissions,
    }));
  }
}
