import { Global, Injectable, Module } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { appRoleName } from './app-role';

/**
 * Runs work inside a transaction scoped to one tenant:
 * the transaction switches to the non-superuser app role and sets
 * `app.tenant_id`, so row-level security policies apply. Callers must still
 * filter by tenant in their own queries — RLS is defense in depth.
 */
@Injectable()
export class TenantDb {
  private readonly role = appRoleName();

  constructor(private readonly dataSource: DataSource) {}

  run<T>(
    tenantId: string,
    work: (em: EntityManager) => Promise<T>,
  ): Promise<T> {
    return this.dataSource.transaction(async (em) => {
      await em.query(`SET LOCAL ROLE ${this.role}`);
      await em.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        tenantId,
      ]);
      return work(em);
    });
  }
}

@Global()
@Module({
  providers: [TenantDb],
  exports: [TenantDb],
})
export class DatabaseModule {}
