import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('tenant_settings')
export class TenantSettings {
  @PrimaryColumn('uuid', { name: 'tenant_id' })
  tenantId: string;

  @Column({ type: 'varchar', length: 64, default: 'UTC' })
  timezone: string;

  @Column({ type: 'varchar', length: 16, default: 'en' })
  locale: string;

  @Column({ type: 'jsonb', default: () => `'{}'::jsonb` })
  settings: Record<string, any>;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
