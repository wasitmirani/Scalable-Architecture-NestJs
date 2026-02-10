import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  BeforeInsert
} from 'typeorm';

import * as bcrypt from 'bcrypt';
import { Helpers } from 'src/common/utils/helpers';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: number;
  // @Column({ type: 'varchar', length: 255, nullable: true })
  // uuid?: string | null;
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

  @Column({ type: 'datetime', nullable: true, name: 'last_login' })
  lastLogin?: Date | null;

  @Column({
    type: 'varchar',
    length: 255,
    default: 'default.png',
    name: 'thumbnail',
  })
  thumbnail: string;





  /**
   * Compare password against Laravel 'bcrypt' hash or plain password.
   * Laravel hashes look like $2y$... (bcrypt 10 salt rounds),
   * otherwise fallback to simple === comparison for plain text.
   */
  async comparePassword(password: string): Promise<boolean> {
    if (typeof this.password === 'string' && this.password.startsWith('$2y$')) {
      // bcryptjs expects $2a$ prefix, so replace $2y$ with $2a$
      const laravelHash = this.password.replace(/^\$2y\$/, '$2a$');
      return await bcrypt.compare(password, laravelHash);
    }
    return password === this.password;
  }

}

export const USER_PUBLIC_COLUMNS: (keyof User)[] = [
  'id',
  'name',
  'email',
  'createdAt',
];