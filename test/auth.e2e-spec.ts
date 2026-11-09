import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import {
  bearer,
  createApp,
  MailOutbox,
  PASSWORD,
  registerAccount,
  uniqueEmail,
} from './helpers';

describe('Auth (e2e)', () => {
  let app: INestApplication<App>;
  let mail: MailOutbox;
  let db: DataSource;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    ({ app, mail } = await createApp());
    db = app.get(DataSource);
  });
  afterAll(() => app.close());

  it('register creates the user, an owned workspace and a session', async () => {
    const email = uniqueEmail('reg');
    const res = await http()
      .post('/api/v1/auth/register')
      .send({
        name: 'Reg User',
        email: email.toUpperCase(),
        password: PASSWORD,
        workspaceName: 'Acme',
      })
      .expect(201);

    const { user, memberships, accessToken, refreshToken } = res.body.data;
    expect(user.email).toBe(email);
    expect(user).not.toHaveProperty('passwordHash');
    expect(user.emailVerified).toBe(false);
    expect(memberships).toHaveLength(1);
    expect(memberships[0].role.key).toBe('owner');
    expect(memberships[0].permissions).toContain('members.manage');
    expect(accessToken).toBeTruthy();
    expect(refreshToken).toBeTruthy();

    await http()
      .post('/api/v1/auth/register')
      .send({ name: 'Dup', email, password: PASSWORD, workspaceName: 'Dup' })
      .expect(409);
  });

  it('rejects weak passwords with a validation error', async () => {
    const res = await http()
      .post('/api/v1/auth/register')
      .send({
        name: 'Weak',
        email: uniqueEmail('weak'),
        password: 'password',
        workspaceName: 'W',
      })
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('login succeeds with the right password and locks after 5 failures', async () => {
    const acct = await registerAccount(app, 'lock');
    await http()
      .post('/api/v1/auth/login')
      .send({ email: acct.email, password: PASSWORD })
      .expect(200);

    for (let i = 0; i < 5; i++) {
      const res = await http()
        .post('/api/v1/auth/login')
        .send({ email: acct.email, password: 'Wrong!Passw0rd' })
        .expect(401);
      expect(res.body.code).toBe('INVALID_CREDENTIALS');
    }
    const locked = await http()
      .post('/api/v1/auth/login')
      .send({ email: acct.email, password: PASSWORD })
      .expect(401);
    expect(locked.body.code).toBe('ACCOUNT_LOCKED');
  });

  it('unknown emails get the same error as wrong passwords', async () => {
    const res = await http()
      .post('/api/v1/auth/login')
      .send({ email: uniqueEmail('nobody'), password: PASSWORD })
      .expect(401);
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('refresh rotates tokens; replaying an old token revokes the session', async () => {
    const acct = await registerAccount(app, 'rotate');

    const first = await http()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: acct.refreshToken })
      .expect(200);
    const rotated = first.body.data.refreshToken;
    expect(rotated).not.toBe(acct.refreshToken);

    // Inside the grace window a replay is treated as a parallel-request race.
    const race = await http()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: acct.refreshToken })
      .expect(401);
    expect(race.body.code).toBe('REFRESH_TOKEN_ALREADY_USED');

    // Later, the same replay means the token leaked: the whole session is revoked.
    await db.query(
      `UPDATE refresh_tokens SET used_at = now() - interval '1 minute' WHERE used_at IS NOT NULL`,
    );
    const reuse = await http()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: acct.refreshToken })
      .expect(401);
    expect(reuse.body.code).toBe('REFRESH_TOKEN_REUSED');

    const afterRevoke = await http()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: rotated })
      .expect(401);
    expect(afterRevoke.body.code).toBe('INVALID_REFRESH_TOKEN');
    const me = await http()
      .get('/api/v1/auth/me')
      .set(bearer(first.body.data.accessToken))
      .expect(401);
    expect(me.body.code).toBe('SESSION_ENDED');
  });

  it('logout ends the session immediately', async () => {
    const acct = await registerAccount(app, 'logout');
    await http()
      .get('/api/v1/auth/me')
      .set(bearer(acct.accessToken))
      .expect(200);
    await http()
      .post('/api/v1/auth/logout')
      .set(bearer(acct.accessToken))
      .expect(200);
    await http()
      .get('/api/v1/auth/me')
      .set(bearer(acct.accessToken))
      .expect(401);
    await http()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: acct.refreshToken })
      .expect(401);
  });

  it('password reset via emailed link revokes existing sessions', async () => {
    const acct = await registerAccount(app, 'reset');
    await http()
      .post('/api/v1/auth/password/forgot')
      .send({ email: acct.email })
      .expect(202);
    // Unknown emails get the identical response.
    await http()
      .post('/api/v1/auth/password/forgot')
      .send({ email: uniqueEmail('ghost') })
      .expect(202);

    const token = mail.tokenFor(acct.email, 'reset');
    const newPassword = 'N3w!Passw0rd';
    await http()
      .post('/api/v1/auth/password/reset')
      .send({ token, password: newPassword })
      .expect(200);
    await http()
      .post('/api/v1/auth/password/reset')
      .send({ token, password: newPassword })
      .expect(400);

    await http()
      .get('/api/v1/auth/me')
      .set(bearer(acct.accessToken))
      .expect(401);
    await http()
      .post('/api/v1/auth/login')
      .send({ email: acct.email, password: PASSWORD })
      .expect(401);
    await http()
      .post('/api/v1/auth/login')
      .send({ email: acct.email, password: newPassword })
      .expect(200);
  });

  it('email verification link marks the email verified', async () => {
    const acct = await registerAccount(app, 'verify');
    const token = mail.tokenFor(acct.email, 'verify');
    await http().post('/api/v1/auth/email/verify').send({ token }).expect(200);
    const me = await http()
      .get('/api/v1/auth/me')
      .set(bearer(acct.accessToken))
      .expect(200);
    expect(me.body.data.user.emailVerified).toBe(true);
  });

  it('lists and revokes own sessions', async () => {
    const acct = await registerAccount(app, 'sessions');
    const second = await http()
      .post('/api/v1/auth/login')
      .send({ email: acct.email, password: PASSWORD })
      .expect(200);

    const list = await http()
      .get('/api/v1/auth/sessions')
      .set(bearer(acct.accessToken))
      .expect(200);
    expect(list.body.data).toHaveLength(2);
    const other = list.body.data.find((s: { current: boolean }) => !s.current);

    await http()
      .delete(`/api/v1/auth/sessions/${other.id}`)
      .set(bearer(acct.accessToken))
      .expect(200);
    await http()
      .get('/api/v1/auth/me')
      .set(bearer(second.body.data.accessToken))
      .expect(401);
  });
});
