import 'reflect-metadata';
// Must load first: it points DB_NAME at the test database before the config is read.
import './setup-env';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { dbOptions } from '../src/database/typeorm.config';

/** Recreates the test database and applies all migrations once per e2e run. */
export default async function globalSetup(): Promise<void> {
  const name = process.env.DB_NAME as string;
  if (!/^[a-z0-9_]+_test$/.test(name)) {
    throw new Error(
      `Refusing to recreate "${name}": test database names must end in _test`,
    );
  }

  const admin = new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: 'postgres',
  });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const dataSource = new DataSource(dbOptions);
  await dataSource.initialize();
  await dataSource.runMigrations();
  await dataSource.destroy();
}
