import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { DataSource, EntityManager } from 'typeorm';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from '../../common/exceptions/custom.exceptions';
import type { Principal, RequestMeta } from '../../common/types/principal';
import { parseDuration, randomToken, sha256 } from '../../common/utils/tokens';
import type { AccessTokenPayload } from '../../common/guards/jwt-auth.guard';
import { AuditService } from '../audit/audit.service';
import { MailService } from '../mail/mail.service';
import { TenantsService } from '../tenants/tenants.service';
import { toPublicUser, User } from '../users/entities/user.entity';
import { ChangePasswordDto, ResetPasswordDto } from './dto/password.dto';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshToken } from './entities/refresh-token.entity';
import { Session } from './entities/session.entity';
import { UserToken, UserTokenPurpose } from './entities/user-token.entity';

export const BCRYPT_ROUNDS = 12;
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_SECONDS = 15 * 60;
/** A refresh token re-presented this soon after use is a parallel-request race, not theft. */
const REUSE_GRACE_MS = 10_000;
const EMAIL_VERIFICATION_TTL_MS = 24 * 3_600_000;
const PASSWORD_RESET_TTL_MS = 3_600_000;

type UserPrincipal = Extract<Principal, { type: 'user' }>;

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  /** Access token lifetime in seconds. */
  expiresIn: number;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly accessTtlMs: number;
  private readonly refreshTtlMs: number;
  private readonly frontendUrl: string;
  /** Compared against when the email is unknown, so response time does not reveal accounts. */
  private readonly dummyHash = bcrypt.hashSync(
    'timing-equalizer',
    BCRYPT_ROUNDS,
  );

  constructor(
    private readonly dataSource: DataSource,
    private readonly jwt: JwtService,
    private readonly tenants: TenantsService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    config: ConfigService,
  ) {
    this.accessTtlMs = parseDuration(
      config.get<string>('JWT_EXPIRES_IN') || '15m',
    );
    this.refreshTtlMs = parseDuration(
      config.get<string>('JWT_REFRESH_EXPIRES_IN') || '7d',
    );
    this.frontendUrl = config.getOrThrow<string>('FRONTEND_URL');
  }

  async register(dto: RegisterDto, meta: RequestMeta) {
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const result = await this.dataSource.transaction(async (em) => {
      const taken = await em.query<unknown[]>(
        `SELECT 1 FROM users WHERE lower(email) = $1`,
        [dto.email],
      );
      if (taken.length > 0)
        throw new ConflictException(
          'An account with this email already exists',
          'EMAIL_TAKEN',
        );

      const { identifiers } = await em.insert(User, {
        name: dto.name,
        email: dto.email,
        passwordHash,
      });
      const userId = identifiers[0].id as string;
      const tenant = await this.tenants.createWithOwner(
        em,
        userId,
        dto.workspaceName,
      );
      const session = await this.startSession(em, userId, meta);
      const actor = this.userActor(userId, dto.email, session.sessionId);
      await this.audit.record(
        {
          tenantId: tenant.id,
          actor,
          action: 'user.registered',
          targetType: 'user',
          targetId: userId,
        },
        meta,
        em,
      );
      await this.audit.record(
        {
          tenantId: tenant.id,
          actor,
          action: 'tenant.created',
          targetType: 'tenant',
          targetId: tenant.id,
        },
        meta,
        em,
      );
      const verifyToken = await this.createUserToken(
        em,
        userId,
        'email_verification',
        EMAIL_VERIFICATION_TTL_MS,
      );
      return { userId, tokens: session.tokens, verifyToken };
    });

    await this.sendSafely(() =>
      this.mail.sendEmailVerification(
        dto.email,
        dto.name,
        this.link('verify-email', result.verifyToken),
      ),
    );
    return { ...result.tokens, ...(await this.profile(result.userId)) };
  }

  async login(dto: LoginDto, meta: RequestMeta) {
    const user = await this.dataSource
      .getRepository(User)
      .createQueryBuilder('u')
      .addSelect(['u.passwordHash', 'u.lockedUntil'])
      .where('lower(u.email) = :email', { email: dto.email })
      .getOne();

    if (!user) {
      await bcrypt.compare(dto.password, this.dummyHash);
      throw new UnauthorizedException(
        'Invalid email or password',
        'INVALID_CREDENTIALS',
      );
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new UnauthorizedException(
        'Too many failed attempts. Try again later.',
        'ACCOUNT_LOCKED',
      );
    }
    if (!(await bcrypt.compare(dto.password, user.passwordHash))) {
      await this.dataSource.query(
        `UPDATE users
            SET failed_login_count = CASE WHEN failed_login_count + 1 >= $2 THEN 0 ELSE failed_login_count + 1 END,
                locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN now() + make_interval(secs => $3) ELSE locked_until END
          WHERE id = $1`,
        [user.id, MAX_FAILED_LOGINS, LOCKOUT_SECONDS],
      );
      await this.audit.record(
        {
          tenantId: null,
          actor: null,
          action: 'auth.login_failed',
          targetType: 'user',
          targetId: user.id,
        },
        meta,
      );
      throw new UnauthorizedException(
        'Invalid email or password',
        'INVALID_CREDENTIALS',
      );
    }
    if (user.status !== 'active')
      throw new UnauthorizedException(
        'Account is disabled',
        'ACCOUNT_DISABLED',
      );

    const tokens = await this.dataSource.transaction(async (em) => {
      await em.update(
        User,
        { id: user.id },
        { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
      );
      const session = await this.startSession(em, user.id, meta);
      await this.audit.record(
        {
          tenantId: null,
          actor: this.userActor(user.id, user.email, session.sessionId),
          action: 'auth.login',
          targetType: 'session',
          targetId: session.sessionId,
        },
        meta,
        em,
      );
      return session.tokens;
    });
    return { ...tokens, ...(await this.profile(user.id)) };
  }

  /**
   * Rotates the refresh token. Presenting an already-used token (outside a short
   * race window) revokes the whole session, since the token may have been stolen.
   */
  async refresh(refreshToken: string, meta: RequestMeta): Promise<AuthTokens> {
    const hash = sha256(refreshToken);
    const outcome = await this.dataSource.transaction(async (em) => {
      const [row] = await em.query<
        Array<{
          session_id: string;
          user_id: string;
          revoked_at: Date | null;
          session_expires: Date;
          token_expires: Date;
          status: string;
        }>
      >(
        `WITH used AS (
           UPDATE refresh_tokens SET used_at = now()
            WHERE token_hash = $1 AND used_at IS NULL
           RETURNING session_id, expires_at
         )
         SELECT used.session_id, s.user_id, s.revoked_at, s.expires_at AS session_expires,
                used.expires_at AS token_expires, u.status
           FROM used JOIN sessions s ON s.id = used.session_id JOIN users u ON u.id = s.user_id`,
        [hash],
      );

      if (!row) {
        const [prior] = await em.query<
          Array<{ session_id: string; used_at: Date; user_id: string }>
        >(
          `SELECT t.session_id, t.used_at, s.user_id FROM refresh_tokens t JOIN sessions s ON s.id = t.session_id
            WHERE t.token_hash = $1`,
          [hash],
        );
        if (!prior) return { kind: 'invalid' as const };
        if (Date.now() - new Date(prior.used_at).getTime() < REUSE_GRACE_MS)
          return { kind: 'race' as const };
        await em.query(
          `UPDATE sessions SET revoked_at = now(), revoked_reason = 'refresh_token_reuse'
            WHERE id = $1 AND revoked_at IS NULL`,
          [prior.session_id],
        );
        await this.audit.record(
          {
            tenantId: null,
            actor: null,
            action: 'auth.refresh_token_reused',
            targetType: 'session',
            targetId: prior.session_id,
            metadata: { userId: prior.user_id },
          },
          meta,
          em,
        );
        return { kind: 'reused' as const };
      }

      const now = new Date();
      if (
        row.revoked_at ||
        row.session_expires <= now ||
        row.token_expires <= now ||
        row.status !== 'active'
      ) {
        return { kind: 'invalid' as const };
      }
      const expiresAt = new Date(Date.now() + this.refreshTtlMs);
      await em.update(
        Session,
        { id: row.session_id },
        { lastUsedAt: now, expiresAt, ip: meta.ip, userAgent: meta.userAgent },
      );
      return {
        kind: 'ok' as const,
        tokens: {
          accessToken: this.signAccess(row.user_id, row.session_id),
          refreshToken: await this.issueRefreshToken(
            em,
            row.session_id,
            expiresAt,
          ),
          expiresIn: this.accessTtlMs / 1000,
        },
      };
    });

    switch (outcome.kind) {
      case 'ok':
        return outcome.tokens;
      case 'race':
        throw new UnauthorizedException(
          'Refresh token was just used by another request',
          'REFRESH_TOKEN_ALREADY_USED',
        );
      case 'reused':
        throw new UnauthorizedException(
          'Refresh token reuse detected; the session was revoked',
          'REFRESH_TOKEN_REUSED',
        );
      default:
        throw new UnauthorizedException(
          'Invalid or expired refresh token',
          'INVALID_REFRESH_TOKEN',
        );
    }
  }

  async logout(user: UserPrincipal, meta: RequestMeta) {
    await this.dataSource.transaction(async (em) => {
      await em.update(
        Session,
        { id: user.sessionId, userId: user.userId },
        { revokedAt: new Date(), revokedReason: 'logout' },
      );
      await this.audit.record(
        {
          tenantId: null,
          actor: user,
          action: 'auth.logout',
          targetType: 'session',
          targetId: user.sessionId,
        },
        meta,
        em,
      );
    });
  }

  listSessions(user: UserPrincipal) {
    return this.dataSource.query(
      `SELECT id, user_agent AS "userAgent", ip, created_at AS "createdAt", last_used_at AS "lastUsedAt",
              expires_at AS "expiresAt", (id = $2) AS current
         FROM sessions
        WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
        ORDER BY last_used_at DESC`,
      [user.userId, user.sessionId],
    );
  }

  async revokeSession(
    user: UserPrincipal,
    sessionId: string,
    meta: RequestMeta,
  ) {
    await this.dataSource.transaction(async (em) => {
      const rows = await em.query<unknown[]>(
        `WITH r AS (
           UPDATE sessions SET revoked_at = now(), revoked_reason = 'revoked_by_user'
            WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id
         ) SELECT id FROM r`,
        [sessionId, user.userId],
      );
      if (rows.length === 0) throw new NotFoundException('Session');
      await this.audit.record(
        {
          tenantId: null,
          actor: user,
          action: 'auth.session_revoked',
          targetType: 'session',
          targetId: sessionId,
        },
        meta,
        em,
      );
    });
  }

  /** Always succeeds from the caller's view so it cannot be used to discover accounts. */
  async forgotPassword(email: string, meta: RequestMeta) {
    const user = await this.dataSource
      .getRepository(User)
      .createQueryBuilder('u')
      .where('lower(u.email) = :email', { email })
      .getOne();
    if (!user || user.status !== 'active') return;

    const token = await this.dataSource.transaction(async (em) => {
      await em.query(
        `UPDATE user_tokens SET used_at = now() WHERE user_id = $1 AND purpose = 'password_reset' AND used_at IS NULL`,
        [user.id],
      );
      await this.audit.record(
        {
          tenantId: null,
          actor: null,
          action: 'auth.password_reset_requested',
          targetType: 'user',
          targetId: user.id,
        },
        meta,
        em,
      );
      return this.createUserToken(
        em,
        user.id,
        'password_reset',
        PASSWORD_RESET_TTL_MS,
      );
    });
    await this.sendSafely(() =>
      this.mail.sendPasswordReset(
        user.email,
        user.name,
        this.link('reset-password', token),
      ),
    );
  }

  async resetPassword(dto: ResetPasswordDto, meta: RequestMeta) {
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    await this.dataSource.transaction(async (em) => {
      const userId = await this.consumeUserToken(
        em,
        dto.token,
        'password_reset',
      );
      await em.update(
        User,
        { id: userId },
        { passwordHash, failedLoginCount: 0, lockedUntil: null },
      );
      await em.query(
        `UPDATE sessions SET revoked_at = now(), revoked_reason = 'password_reset' WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId],
      );
      await this.audit.record(
        {
          tenantId: null,
          actor: null,
          action: 'auth.password_reset',
          targetType: 'user',
          targetId: userId,
        },
        meta,
        em,
      );
    });
  }

  async changePassword(
    user: UserPrincipal,
    dto: ChangePasswordDto,
    meta: RequestMeta,
  ) {
    const current = await this.dataSource
      .getRepository(User)
      .createQueryBuilder('u')
      .addSelect('u.passwordHash')
      .where('u.id = :id', { id: user.userId })
      .getOneOrFail();
    if (!(await bcrypt.compare(dto.currentPassword, current.passwordHash))) {
      throw new BadRequestException(
        'Current password is incorrect',
        'INVALID_PASSWORD',
      );
    }
    const passwordHash = await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS);
    await this.dataSource.transaction(async (em) => {
      await em.update(User, { id: user.userId }, { passwordHash });
      await em.query(
        `UPDATE sessions SET revoked_at = now(), revoked_reason = 'password_changed'
          WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`,
        [user.userId, user.sessionId],
      );
      await this.audit.record(
        {
          tenantId: null,
          actor: user,
          action: 'auth.password_changed',
          targetType: 'user',
          targetId: user.userId,
        },
        meta,
        em,
      );
    });
  }

  async verifyEmail(token: string, meta: RequestMeta) {
    await this.dataSource.transaction(async (em) => {
      const userId = await this.consumeUserToken(
        em,
        token,
        'email_verification',
      );
      await em.query(
        `UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1`,
        [userId],
      );
      await this.audit.record(
        {
          tenantId: null,
          actor: null,
          action: 'auth.email_verified',
          targetType: 'user',
          targetId: userId,
        },
        meta,
        em,
      );
    });
  }

  async resendVerification(user: UserPrincipal) {
    const row = await this.dataSource
      .getRepository(User)
      .findOneByOrFail({ id: user.userId });
    if (row.emailVerifiedAt)
      throw new BadRequestException(
        'Email is already verified',
        'ALREADY_VERIFIED',
      );
    const token = await this.dataSource.transaction((em) =>
      this.createUserToken(
        em,
        row.id,
        'email_verification',
        EMAIL_VERIFICATION_TTL_MS,
      ),
    );
    await this.sendSafely(() =>
      this.mail.sendEmailVerification(
        row.email,
        row.name,
        this.link('verify-email', token),
      ),
    );
  }

  /** Current user plus every workspace they belong to (with permissions, for the UI). */
  async profile(userId: string) {
    const user = await this.dataSource
      .getRepository(User)
      .findOneByOrFail({ id: userId });
    return {
      user: toPublicUser(user),
      memberships: await this.tenants.listForUser(userId),
    };
  }

  private async startSession(
    em: EntityManager,
    userId: string,
    meta: RequestMeta,
  ) {
    const expiresAt = new Date(Date.now() + this.refreshTtlMs);
    const { identifiers } = await em.insert(Session, {
      userId,
      userAgent: meta.userAgent,
      ip: meta.ip,
      expiresAt,
    });
    const sessionId = identifiers[0].id as string;
    const tokens: AuthTokens = {
      accessToken: this.signAccess(userId, sessionId),
      refreshToken: await this.issueRefreshToken(em, sessionId, expiresAt),
      expiresIn: this.accessTtlMs / 1000,
    };
    return { sessionId, tokens };
  }

  private async issueRefreshToken(
    em: EntityManager,
    sessionId: string,
    expiresAt: Date,
  ): Promise<string> {
    const token = randomToken();
    await em.insert(RefreshToken, {
      sessionId,
      tokenHash: sha256(token),
      expiresAt,
    });
    return token;
  }

  private signAccess(userId: string, sessionId: string): string {
    const payload: AccessTokenPayload = {
      sub: userId,
      sid: sessionId,
      typ: 'access',
    };
    return this.jwt.sign(payload);
  }

  private async createUserToken(
    em: EntityManager,
    userId: string,
    purpose: UserTokenPurpose,
    ttlMs: number,
  ) {
    const token = randomToken();
    await em.insert(UserToken, {
      userId,
      purpose,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + ttlMs),
    });
    return token;
  }

  private async consumeUserToken(
    em: EntityManager,
    token: string,
    purpose: UserTokenPurpose,
  ): Promise<string> {
    const [row] = await em.query<Array<{ user_id: string }>>(
      `WITH t AS (
         UPDATE user_tokens SET used_at = now()
          WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
         RETURNING user_id
       ) SELECT user_id FROM t`,
      [sha256(token), purpose],
    );
    if (!row)
      throw new BadRequestException(
        'This link is invalid or has expired',
        'INVALID_TOKEN',
      );
    return row.user_id;
  }

  private userActor(
    userId: string,
    email: string,
    sessionId: string,
  ): UserPrincipal {
    return { type: 'user', userId, email, sessionId, isPlatformAdmin: false };
  }

  private link(path: string, token: string): string {
    return `${this.frontendUrl}/${path}?token=${encodeURIComponent(token)}`;
  }

  /** Email failure must not undo a committed account change; it is logged and can be retried. */
  private async sendSafely(send: () => Promise<void>) {
    try {
      await send();
    } catch (err) {
      this.logger.error(`Email delivery failed: ${(err as Error).message}`);
    }
  }
}
