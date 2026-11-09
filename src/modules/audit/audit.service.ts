import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { TenantDb } from '../../database/database.module';
import {
  CursorQueryDto,
  paginateByCursor,
} from '../../common/pagination/cursor';
import type {
  Principal,
  RequestMeta,
  TenantContext,
} from '../../common/types/principal';
import { AuditLog } from './entities/audit-log.entity';

export interface AuditEntry {
  tenantId: string | null;
  actor: Principal | null;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, any>;
}

/** Append-only record of security-sensitive actions. */
@Injectable()
export class AuditService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantDb: TenantDb,
  ) {}

  /** Pass `em` to write inside the caller's transaction (commits or rolls back with it). */
  async record(
    entry: AuditEntry,
    meta: RequestMeta,
    em?: EntityManager,
  ): Promise<void> {
    const actor = entry.actor;
    await (em ?? this.dataSource.manager).insert(AuditLog, {
      tenantId: entry.tenantId,
      actorType: actor?.type ?? 'system',
      actorId: actor
        ? actor.type === 'user'
          ? actor.userId
          : actor.apiKeyId
        : null,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      metadata: entry.metadata ?? {},
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    });
  }

  list(tenant: TenantContext, query: CursorQueryDto & { action?: string }) {
    return this.tenantDb.run(tenant.tenantId, (em) => {
      const qb = em
        .createQueryBuilder(AuditLog, 'a')
        .where('a.tenant_id = :tenantId', { tenantId: tenant.tenantId });
      if (query.action)
        qb.andWhere('a.action = :action', { action: query.action });
      return paginateByCursor(qb, query);
    });
  }
}
