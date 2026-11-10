import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager, IsNull } from 'typeorm';
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
import { randomToken, sha256 } from '../../common/utils/tokens';
import { AccessService } from '../access/access.service';
import { AuditService } from '../audit/audit.service';
import { MailService } from '../mail/mail.service';
import { TenantsService } from '../tenants/tenants.service';
import { CreateInvitationDto } from './dto/invitation.dto';
import { Invitation } from './entities/invitation.entity';
import { assertSeat } from '../platform/plan-limits';

const INVITATION_TTL_MS = 7 * 24 * 3_600_000;

@Injectable()
export class InvitationsService {
  private readonly logger = new Logger(InvitationsService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantDb: TenantDb,
    private readonly access: AccessService,
    private readonly tenants: TenantsService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  listPending(tenant: TenantContext) {
    return this.tenantDb.run(tenant.tenantId, (em) =>
      em.query(
        `SELECT i.id, i.email, i.expires_at AS "expiresAt", i.created_at AS "createdAt",
                json_build_object('id', r.id, 'key', r.key, 'name', r.name) AS role,
                json_build_object('id', u.id, 'name', u.name) AS "invitedBy"
           FROM invitations i
           JOIN roles r ON r.id = i.role_id
           LEFT JOIN users u ON u.id = i.invited_by
          WHERE i.tenant_id = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL
          ORDER BY i.created_at DESC`,
        [tenant.tenantId],
      ),
    );
  }

  async create(
    tenant: TenantContext,
    actor: Principal,
    dto: CreateInvitationDto,
    meta: RequestMeta,
  ) {
    const token = randomToken();
    const result = await this.tenantDb.run(tenant.tenantId, async (em) => {
      const role = await this.access.getAssignableRole(em, tenant, dto.roleId);
      const [{ is_member }] = await em.query<Array<{ is_member: boolean }>>(
        `SELECT EXISTS (SELECT 1 FROM tenant_members m JOIN users u ON u.id = m.user_id
                         WHERE m.tenant_id = $1 AND lower(u.email) = $2) AS is_member`,
        [tenant.tenantId, dto.email],
      );
      if (is_member)
        throw new ConflictException(
          'This person is already a member',
          'ALREADY_MEMBER',
        );

      const pending = await em
        .createQueryBuilder(Invitation, 'i')
        .where(
          'i.tenant_id = :t AND lower(i.email) = :e AND i.accepted_at IS NULL AND i.revoked_at IS NULL',
          {
            t: tenant.tenantId,
            e: dto.email,
          },
        )
        .getExists();
      if (pending)
        throw new ConflictException(
          'An invitation is already pending for this email',
          'INVITATION_PENDING',
        );
      await assertSeat(em, tenant.tenantId);

      const { identifiers } = await em.insert(Invitation, {
        tenantId: tenant.tenantId,
        email: dto.email,
        roleId: role.id,
        tokenHash: sha256(token),
        invitedBy: actor.type === 'user' ? actor.userId : null,
        expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
      });
      const id = identifiers[0].id as string;
      await this.audit.record(
        {
          tenantId: tenant.tenantId,
          actor,
          action: 'invitation.created',
          targetType: 'invitation',
          targetId: id,
          metadata: { email: dto.email, role: role.key },
        },
        meta,
        em,
      );
      return { id, roleName: role.name };
    });

    await this.sendEmail(
      tenant.tenantId,
      actor,
      dto.email,
      result.roleName,
      token,
    );
    return { id: result.id };
  }

  async resend(
    tenant: TenantContext,
    actor: Principal,
    id: string,
    meta: RequestMeta,
  ) {
    const token = randomToken();
    const invite = await this.tenantDb.run(tenant.tenantId, async (em) => {
      const pending = await this.findPending(em, tenant.tenantId, id);
      await em.update(
        Invitation,
        { id, tenantId: tenant.tenantId },
        {
          tokenHash: sha256(token),
          expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
        },
      );
      await this.audit.record(
        {
          tenantId: tenant.tenantId,
          actor,
          action: 'invitation.resent',
          targetType: 'invitation',
          targetId: id,
        },
        meta,
        em,
      );
      const [role] = await em.query<Array<{ name: string }>>(
        `SELECT name FROM roles WHERE id = $1`,
        [pending.roleId],
      );
      return { email: pending.email, roleName: role.name };
    });
    await this.sendEmail(
      tenant.tenantId,
      actor,
      invite.email,
      invite.roleName,
      token,
    );
  }

  async revoke(
    tenant: TenantContext,
    actor: Principal,
    id: string,
    meta: RequestMeta,
  ) {
    await this.tenantDb.run(tenant.tenantId, async (em) => {
      await this.findPending(em, tenant.tenantId, id);
      await em.update(
        Invitation,
        { id, tenantId: tenant.tenantId },
        { revokedAt: new Date() },
      );
      await this.audit.record(
        {
          tenantId: tenant.tenantId,
          actor,
          action: 'invitation.revoked',
          targetType: 'invitation',
          targetId: id,
        },
        meta,
        em,
      );
    });
  }

  /** Public: lets the invite page show what is being accepted. Reveals nothing without the token. */
  async preview(token: string) {
    const [row] = await this.dataSource.query<
      Array<{
        email: string;
        expires_at: Date;
        tenant_name: string;
        role_name: string;
        inviter_name: string | null;
      }>
    >(
      `SELECT i.email, i.expires_at, t.name AS tenant_name, r.name AS role_name, u.name AS inviter_name
         FROM invitations i
         JOIN tenants t ON t.id = i.tenant_id
         JOIN roles r ON r.id = i.role_id
         LEFT JOIN users u ON u.id = i.invited_by
        WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL
          AND i.expires_at > now() AND t.status = 'active'`,
      [sha256(token)],
    );
    if (!row) throw new NotFoundException('Invitation', 'INVALID_INVITATION');
    return {
      email: row.email,
      tenantName: row.tenant_name,
      roleName: row.role_name,
      inviterName: row.inviter_name,
      expiresAt: row.expires_at,
    };
  }

  /** The signed-in user joins the workspace. Their email must match the invitation. */
  async accept(
    user: Extract<Principal, { type: 'user' }>,
    token: string,
    meta: RequestMeta,
  ) {
    return this.dataSource.transaction(async (em) => {
      const invite = await em
        .createQueryBuilder(Invitation, 'i')
        .setLock('pessimistic_write')
        .where('i.token_hash = :hash', { hash: sha256(token) })
        .getOne();
      if (
        !invite ||
        invite.acceptedAt ||
        invite.revokedAt ||
        invite.expiresAt <= new Date()
      ) {
        throw new BadRequestException(
          'This invitation is invalid or has expired',
          'INVALID_INVITATION',
        );
      }
      if (invite.email.toLowerCase() !== user.email.toLowerCase()) {
        throw new ForbiddenException(
          'This invitation was sent to a different email address',
          'INVITATION_EMAIL_MISMATCH',
        );
      }
      const [tenant] = await em.query<
        Array<{ id: string; name: string; status: string }>
      >(`SELECT id, name, status FROM tenants WHERE id = $1`, [
        invite.tenantId,
      ]);
      if (tenant.status !== 'active')
        throw new ForbiddenException(
          'This workspace is suspended',
          'TENANT_SUSPENDED',
        );

      const memberId = await this.tenants.addMember(em, {
        tenantId: invite.tenantId,
        userId: user.userId,
        roleId: invite.roleId,
        invitedBy: invite.invitedBy,
      });
      await em.update(
        Invitation,
        { id: invite.id },
        { acceptedAt: new Date(), acceptedBy: user.userId },
      );
      // Following the emailed link proves ownership of the address.
      await em.query(
        `UPDATE users SET email_verified_at = now() WHERE id = $1 AND email_verified_at IS NULL`,
        [user.userId],
      );
      await this.audit.record(
        {
          tenantId: invite.tenantId,
          actor: user,
          action: 'invitation.accepted',
          targetType: 'member',
          targetId: memberId,
          metadata: { invitationId: invite.id },
        },
        meta,
        em,
      );
      return { tenant: { id: tenant.id, name: tenant.name }, memberId };
    });
  }

  private async findPending(
    em: EntityManager,
    tenantId: string,
    id: string,
  ): Promise<Invitation> {
    const invite = await em.findOne(Invitation, {
      where: { id, tenantId, acceptedAt: IsNull(), revokedAt: IsNull() },
    });
    if (!invite) throw new NotFoundException('Invitation');
    return invite;
  }

  private async sendEmail(
    tenantId: string,
    actor: Principal,
    email: string,
    roleName: string,
    token: string,
  ) {
    const [tenant] = await this.dataSource.query<Array<{ name: string }>>(
      `SELECT name FROM tenants WHERE id = $1`,
      [tenantId],
    );
    const [inviter] =
      actor.type === 'user'
        ? await this.dataSource.query<Array<{ name: string }>>(
            `SELECT name FROM users WHERE id = $1`,
            [actor.userId],
          )
        : [{ name: tenant.name }];
    const link = `${this.config.getOrThrow<string>('FRONTEND_URL')}/accept-invitation?token=${encodeURIComponent(token)}`;
    try {
      await this.mail.sendInvitation(
        email,
        inviter.name,
        tenant.name,
        roleName,
        link,
      );
    } catch (err) {
      // The invitation exists; the admin can resend it.
      this.logger.error(
        `Invitation email to ${email} failed: ${(err as Error).message}`,
      );
    }
  }
}
