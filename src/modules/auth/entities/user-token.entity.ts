import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

export type UserTokenPurpose = 'email_verification' | 'password_reset';

/** Single-use, hashed tokens sent by email. */
@Entity('user_tokens')
export class UserToken {
  @PrimaryColumn('uuid', { default: () => 'uuidv7()' })
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ type: 'varchar', length: 30 })
  purpose: UserTokenPurpose;

  @Column({ name: 'token_hash', type: 'char', length: 64 })
  tokenHash: string;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @Column({ name: 'used_at', type: 'timestamptz', nullable: true })
  usedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
