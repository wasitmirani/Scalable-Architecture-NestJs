import { DataSourceOptions } from 'typeorm';
import * as dotenv from 'dotenv';

dotenv.config();

type DbDriver = 'mysql' | 'mariadb' | 'postgres';

const raw = (process.env.DB_DRIVER || 'mysql').toLowerCase();
const type: DbDriver = ['postgres', 'postgresql', 'pgsql'].includes(raw)
  ? 'postgres'
  : raw === 'mariadb'
    ? 'mariadb'
    : 'mysql';

export const dbOptions = {
  type,
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || (type === 'postgres' ? 5432 : 3306),
  username: process.env.DB_USER || (type === 'postgres' ? 'postgres' : 'root'),
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'sample_db',
  synchronize:
    process.env.DB_SYNCHRONIZE === 'true' ||
    process.env.NODE_ENV !== 'production',
   logging: process.env.DB_LOGGING !== 'false',
} as DataSourceOptions;
