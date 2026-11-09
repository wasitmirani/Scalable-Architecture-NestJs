import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { DataSource, EntityManager, In, IsNull } from 'typeorm';
import { TenantDb } from '../../database/database.module';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '../../common/exceptions/custom.exceptions';
import type {
  Principal,
  RequestMeta,
  TenantContext,
} from '../../common/types/principal';
import { randomToken, safeEqualHex, sha256 } from '../../common/utils/tokens';
import { assertGrantable } from '../access/access.service';
import { Permission } from '../access/entities/permission.entity';
import { AuditService } from '../audit/audit.service';
import { CreateApiKeyDto } from './dto/api-key.dto';
import { ApiKey } from './entities/api-key.entity';

/** Key format: `bk_<12 hex prefix>_<43 char secret>`. Only sha256(secret) is stored. */
const KEY_PATTERN = /^bk_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;

@Injectable()
export class ApiKeysService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
  ) {}

  list(tenant: TenantContext): Promise<ApiKey[]> {
    return this.tenantDb.run(tenant.tenantId, (em) =>
      em.find(ApiKey, {
        where: { tenantId: tenant.tenantId },
        order: { createdAt: 'DESC' },
      }),
    );
  }

  /** Returns the full key exactly once; it cannot be retrieved later. */
  async create(
    tenant: TenantContext,
    actor: Principal,
    dto: CreateApiKeyDto,
    meta: RequestMeta,
  ) {
    const scopes = [...new Set(dto.scopes)];
    const known = await this.dataSource
      .getRepository(Permission)
      .countBy({ key: In(scopes) });
    if (known !== scopes.length)
      throw new BadRequestException('Unknown scope', 'UNKNOWN_PERMISSION');
    assertGrantable(tenant, scopes);

    const prefix = randomBytes(6).toString('hex');
    const secret = randomToken();
    return this.tenantDb.run(tenant.tenantId, async (em) => {
      const { identifiers } = await em.insert(ApiKey, {
        tenantId: tenant.tenantId,
        name: dto.name,
        prefix,
        secretHash: sha256(secret),
        scopes,
        createdBy: actor.type === 'user' ? actor.userId : null,
        expiresAt: dto.expiresAt ?? null,
      });
      const id = identifiers[0].id as string;
      await this.audit.record(
        {
          tenantId: tenant.tenantId,
          actor,
          action: 'api_key.created',
          targetType: 'api_key',
          targetId: id,
          metadata: { name: dto.name, scopes },
        },
        meta,
        em,
      );
      return {
        apiKey: await this.findActive(em, tenant.tenantId, id),
        key: `bk_${prefix}_${secret}`,
      };
    });
  }

  async rotate(
    tenant: TenantContext,
    actor: Principal,
    id: string,
    meta: RequestMeta,
  ) {
    const secret = randomToken();
    return this.tenantDb.run(tenant.tenantId, async (em) => {
      const apiKey = await this.findActive(em, tenant.tenantId, id);
      await em.update(
        ApiKey,
        { id, tenantId: tenant.tenantId },
        { secretHash: sha256(secret) },
      );
      await this.audit.record(
        {
          tenantId: tenant.tenantId,
          actor,
          action: 'api_key.rotated',
          targetType: 'api_key',
          targetId: id,
        },
        meta,
        em,
      );
      return { apiKey, key: `bk_${apiKey.prefix}_${secret}` };
    });
  }

  async revoke(
    tenant: TenantContext,
    actor: Principal,
    id: string,
    meta: RequestMeta,
  ) {
    await this.tenantDb.run(tenant.tenantId, async (em) => {
      await this.findActive(em, tenant.tenantId, id);
      await em.update(
        ApiKey,
        { id, tenantId: tenant.tenantId },
        { revokedAt: new Date() },
      );
      await this.audit.record(
        {
          tenantId: tenant.tenantId,
          actor,
          action: 'api_key.revoked',
          targetType: 'api_key',
          targetId: id,
        },
        meta,
        em,
      );
    });
  }

  /** Authenticates an `X-Api-Key` header value. Runs outside any tenant context. */
  async authenticate(raw: string): Promise<Principal> {
    const match = KEY_PATTERN.exec(raw);
    if (!match)
      throw new UnauthorizedException('Invalid API key', 'INVALID_API_KEY');
    const [, prefix, secret] = match;

    const [row] = await this.dataSource.query<
      Array<{
        id: string;
        tenant_id: string;
        secret_hash: string;
        scopes: string[];
        expires_at: Date | null;
        revoked_at: Date | null;
        tenant_status: string;
      }>
    >(
      `SELECT k.id, k.tenant_id, k.secret_hash, k.scopes, k.expires_at, k.revoked_at, t.status AS tenant_status
         FROM api_keys k JOIN tenants t ON t.id = k.tenant_id
        WHERE k.prefix = $1`,
      [prefix],
    );
    if (
      !row ||
      !safeEqualHex(row.secret_hash, sha256(secret)) ||
      row.revoked_at
    ) {
      throw new UnauthorizedException('Invalid API key', 'INVALID_API_KEY');
    }
    if (row.expires_at && row.expires_at <= new Date()) {
      throw new UnauthorizedException('API key has expired', 'API_KEY_EXPIRED');
    }
    if (row.tenant_status !== 'active') {
      throw new ForbiddenException(
        'This workspace is suspended',
        'TENANT_SUSPENDED',
      );
    }

    // Throttled so a busy key does not write on every request.
    await this.dataSource.query(
      `UPDATE api_keys SET last_used_at = now()
        WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
      [row.id],
    );
    return {
      type: 'api_key',
      apiKeyId: row.id,
      tenantId: row.tenant_id,
      scopes: row.scopes,
    };
  }

  private async findActive(
    em: EntityManager,
    tenantId: string,
    id: string,
  ): Promise<ApiKey> {
    const apiKey = await em.findOne(ApiKey, {
      where: { id, tenantId, revokedAt: IsNull() },
    });
    if (!apiKey) throw new NotFoundException('API key');
    return apiKey;
  }
}
