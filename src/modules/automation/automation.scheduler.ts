import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RecordsService } from '../records/records.service';
import { AutomationService } from './automation.service';

const INTERVAL_MS = 30_000;

/**
 * Durable delays: every 30 seconds, resumes waiting runs whose time has come in
 * every workspace (run reads also resume them, so the UI never shows stale state).
 * Disable with AUTOMATION_SCHEDULER=off (e.g. when a separate worker runs it).
 */
@Injectable()
export class AutomationScheduler
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(AutomationScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly records: RecordsService,
    private readonly automation: AutomationService,
  ) {}

  onApplicationBootstrap() {
    if (
      process.env.AUTOMATION_SCHEDULER === 'off' ||
      process.env.NODE_ENV === 'test'
    )
      return;
    this.timer = setInterval(() => void this.sweep(), INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep() {
    if (this.busy) return;
    this.busy = true;
    try {
      // The connection role owns the table, so this cross-tenant read is not limited by RLS.
      const due = await this.dataSource.query<{ tenant_id: string }[]>(
        `SELECT DISTINCT tenant_id FROM product_records
         WHERE collection = 'executions' AND data->>'status' = 'waiting'
           AND data->>'test' = 'false' AND (data->>'resumeAt')::timestamptz <= now()`,
      );
      for (const { tenant_id } of due) {
        const tenant = {
          tenantId: tenant_id,
          memberId: null,
          roleKey: null,
          permissions: new Set<string>(),
        };
        try {
          const resumed = await this.records.run(tenant, 'Scheduler', (ctx) =>
            this.automation.tick(ctx),
          );
          if (resumed)
            this.logger.log(
              `Resumed ${resumed} run(s) in workspace ${tenant_id}`,
            );
        } catch (error) {
          this.logger.error(
            `Resuming runs failed for workspace ${tenant_id}: ${(error as Error).message}`,
          );
        }
      }
    } catch (error) {
      this.logger.error(`Scheduler sweep failed: ${(error as Error).message}`);
    } finally {
      this.busy = false;
    }
  }
}
