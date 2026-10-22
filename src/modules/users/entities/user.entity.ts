import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  BeforeInsert,
  BeforeUpdate,
} from 'typeorm';

import * as bcrypt from 'bcrypt';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'varchar', length: 255 })
  email: string;

  @Column({ type: 'timestamp', nullable: true, name: 'email_verified_at' })
  emailVerifiedAt?: Date | null;

  @Column({ type: 'varchar', length: 255 })
  password: string;

  @Column({ type: 'varchar', length: 100, nullable: true, name: 'remember_token' })
  rememberToken?: string | null;

  @CreateDateColumn({ type: 'timestamp', nullable: true, name: 'created_at' })
  createdAt?: Date | null;

  @UpdateDateColumn({ type: 'timestamp', nullable: true, name: 'updated_at' })
  updatedAt?: Date | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  token?: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'user_name' })
  userName?: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  slug?: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'first_name' })
  firstName?: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'last_name' })
  lastName?: string | null;

  @Column({ type: 'timestamp', nullable: true, name: 'last_login' })
  lastLogin?: Date | null;

  @Column({
    type: 'varchar',
    length: 255,
    default: 'default.png',
    name: 'thumbnail',
  })
  thumbnail: string;

  private static readonly BCRYPT_ROUNDS = 12;
  private static readonly BCRYPT_PREFIX = /^\$2[aby]\$/;

  @BeforeInsert()
  @BeforeUpdate()
  async hashPassword(): Promise<void> {
    if (!this.password || User.BCRYPT_PREFIX.test(this.password)) {
      return;
    }
    this.password = await bcrypt.hash(this.password, User.BCRYPT_ROUNDS);
  }

  /**
   * Compare against bcrypt ($2a$ / $2b$ / Laravel $2y$) or plain-text passwords.
   */
  async comparePassword(plainPassword: string): Promise<boolean> {
    if (!plainPassword || typeof this.password !== 'string') {
      return false;
    }

    if (User.BCRYPT_PREFIX.test(this.password)) {
      // Node bcrypt accepts $2a$ / $2b$; normalize Laravel $2y$ → $2a$
      const normalizedHash = this.password.replace(/^\$2y\$/, '$2a$');
      return bcrypt.compare(plainPassword, normalizedHash);
    }

    return plainPassword === this.password;
  }
}

export const USER_PUBLIC_COLUMNS: (keyof User)[] = [
  'id',
  'name',
  'email',
  'createdAt',
];
