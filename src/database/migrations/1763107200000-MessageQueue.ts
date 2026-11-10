import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Email delivery queue: the worker claims `messages` rows with status `queued`
 * in created order (FOR UPDATE SKIP LOCKED). A partial index keeps that cheap
 * as the message log grows; scheduled campaigns get one for the launch sweep.
 */
export class MessageQueue1763107200000 implements MigrationInterface {
  name = 'MessageQueue1763107200000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE INDEX IF NOT EXISTS product_records_message_queue_idx ON product_records (created_at)
       WHERE collection = 'messages' AND data->>'status' = 'queued'`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS product_records_scheduled_campaigns_idx ON product_records (tenant_id)
       WHERE collection = 'campaigns' AND data->>'status' = 'scheduled'`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS product_records_message_queue_idx`);
    await q.query(
      `DROP INDEX IF EXISTS product_records_scheduled_campaigns_idx`,
    );
  }
}
