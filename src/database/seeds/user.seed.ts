import { DataSource } from 'typeorm';
import { User } from '../../modules/users/entities/user.entity';

export async function seedDefaultUser(dataSource: DataSource): Promise<void> {
  const repo = dataSource.getRepository(User);
  const email = process.env.SEED_ADMIN_EMAIL || 'admin@example.com';

  if (await repo.existsBy({ email })) {
    console.log(`[seed] user already exists: ${email}`);
    return;
  }

  const user = repo.create({
    email,
    name: process.env.SEED_ADMIN_NAME || 'Admin',
    password: process.env.SEED_ADMIN_PASSWORD || 'Password123!',
    userName: 'admin',
    firstName: 'Admin',
    lastName: 'User',
    emailVerifiedAt: new Date(),
  });

  await repo.save(user);
  console.log(`[seed] created user: ${email}`);
}
