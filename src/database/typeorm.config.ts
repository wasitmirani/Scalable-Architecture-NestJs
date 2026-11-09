import { join } from 'path';
import { DataSourceOptions } from 'typeorm';
import * as dotenv from 'dotenv';

dotenv.config({ quiet: true });

/**
 * PostgreSQL is the only supported database. The schema is owned by the
 * migrations in ./migrations — `synchronize` is never enabled.
 */
export const dbOptions: DataSourceOptions = {
  type: 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  username: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'birdcrm_db',
  synchronize: false,
  logging: process.env.DB_LOGGING === 'true',
  entities: [join(__dirname, '..', 'modules', '**', '*.entity.{ts,js}')],
  migrations: [join(__dirname, 'migrations', '*.{ts,js}')],
  migrationsTransactionMode: 'each',
};
