import 'reflect-metadata';
import { TypeOrmModule } from '@nestjs/typeorm';

import * as dotenv from 'dotenv';

dotenv.config();


const isProduction = process.env.NODE_ENV === 'production';

export const DatabaseConnection = TypeOrmModule.forRoot({
  type: process.env.DB_DRIVER as any || 'mysql',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  username: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'sample_db',
  autoLoadEntities: true,
  // Auto-create tables in development; use migrations in production
  synchronize: process.env.DB_SYNCHRONIZE === 'true' || !isProduction,
  logging: true,      // Optional: enable query logging
  migrationsRun: false,
  migrations: [],
});

export default DatabaseConnection;
