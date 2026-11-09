import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController', () => {
  const query = jest.fn();
  let appController: AppController;

  beforeEach(async () => {
    query.mockReset();
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService, { provide: DataSource, useValue: { query } }],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  it('reports ok when the database answers', async () => {
    query.mockResolvedValue([{ '?column?': 1 }]);
    await expect(appController.health()).resolves.toEqual({
      status: 'ok',
      database: 'ok',
    });
  });

  it('reports 503 when the database is unreachable', async () => {
    query.mockRejectedValue(new Error('connection refused'));
    await expect(appController.health()).rejects.toMatchObject({ status: 503 });
  });
});
