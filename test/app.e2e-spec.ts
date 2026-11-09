import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createApp } from './helpers';

describe('App (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    ({ app } = await createApp());
  });
  afterAll(() => app.close());

  it('GET /api/health is public and checks the database', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/health')
      .expect(200);
    expect(res.body.data).toEqual({ status: 'ok', database: 'ok' });
  });

  it('protected routes require authentication', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/tenants')
      .expect(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
  });

  it('echoes a well-formed X-Request-Id and includes it in errors', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/tenants')
      .set('X-Request-Id', 'test-request-0001')
      .expect(401);
    expect(res.headers['x-request-id']).toBe('test-request-0001');
    expect(res.body.requestId).toBe('test-request-0001');
  });
});
