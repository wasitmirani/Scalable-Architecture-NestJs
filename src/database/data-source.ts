import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { dbOptions } from './typeorm.config';

/** Data source for the TypeORM CLI (npm run migration:*). */
export default new DataSource(dbOptions);
