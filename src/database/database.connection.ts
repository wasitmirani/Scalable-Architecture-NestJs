import 'reflect-metadata';
import { TypeOrmModule } from '@nestjs/typeorm';

import * as dotenv from 'dotenv';

dotenv.config();


export const DatabaseConnection = TypeOrmModule.forRoot({
  type: 'mysql',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  username: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'sample_db',
  autoLoadEntities: true,
  synchronize: false, // Never use true in production!
  logging: true,      // Optional: enable query logging
  migrationsRun: false,
  migrations: [],
});

export default DatabaseConnection;
