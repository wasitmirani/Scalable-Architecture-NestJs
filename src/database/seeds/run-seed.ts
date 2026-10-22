import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { dbOptions } from '../typeorm.config';
import { User } from '../../modules/users/entities/user.entity';
import { seedDefaultUser } from './user.seed';

async function run(): Promise<void> {
  const dataSource = new DataSource({
    ...dbOptions,
    entities: [User],
  });

  await dataSource.initialize();
  console.log(`[seed] connected (${dbOptions.type} / ${dbOptions.database})`);

  await seedDefaultUser(dataSource);

  await dataSource.destroy();
  console.log('[seed] done');
}

run().catch((err) => {
  console.error('[seed] failed:', err.message);
  process.exit(1);
});
