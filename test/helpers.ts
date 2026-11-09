import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { MailService } from '../src/modules/mail/mail.service';

export const PASSWORD = 'Str0ng!Passw0rd';

/** Captures outgoing platform emails so tests can follow their links. */
export class MailOutbox {
  sent: Array<{ to: string; kind: string; link: string }> = [];

  sendEmailVerification = async (to: string, _name: string, link: string) =>
    this.push(to, 'verify', link);
  sendPasswordReset = async (to: string, _name: string, link: string) =>
    this.push(to, 'reset', link);
  sendInvitation = async (
    to: string,
    _inviter: string,
    _tenant: string,
    _role: string,
    link: string,
  ) => this.push(to, 'invite', link);

  /** Token from the most recent email of `kind` sent to `to`. */
  tokenFor(to: string, kind: string): string {
    const mail = [...this.sent]
      .reverse()
      .find((m) => m.to === to && m.kind === kind);
    if (!mail) throw new Error(`No ${kind} email sent to ${to}`);
    return new URL(mail.link).searchParams.get('token') as string;
  }

  private push(to: string, kind: string, link: string) {
    this.sent.push({ to, kind, link });
    return Promise.resolve();
  }
}

export async function createApp(): Promise<{
  app: INestApplication<App>;
  mail: MailOutbox;
}> {
  const mail = new MailOutbox();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MailService)
    .useValue(mail)
    .compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  configureApp(app);
  await app.init();
  return { app, mail };
}

export interface TestAccount {
  email: string;
  userId: string;
  tenantId: string;
  accessToken: string;
  refreshToken: string;
}

let counter = 0;
export function uniqueEmail(label: string): string {
  counter += 1;
  return `${label}.${Date.now().toString(36)}${counter}@example.test`;
}

export async function registerAccount(
  app: INestApplication<App>,
  label: string,
): Promise<TestAccount> {
  const email = uniqueEmail(label);
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/register')
    .send({
      name: `${label} user`,
      email,
      password: PASSWORD,
      workspaceName: `${label} workspace`,
    })
    .expect(201);
  const data = res.body.data;
  return {
    email,
    userId: data.user.id,
    tenantId: data.memberships[0].tenant.id,
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
  };
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
