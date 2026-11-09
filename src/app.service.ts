import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ServiceUnavailableException } from './common/exceptions/custom.exceptions';

@Injectable()
export class AppService {
  constructor(private readonly dataSource: DataSource) {}

  async health() {
    try {
      await this.dataSource.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException('Database unavailable');
    }
    return { status: 'ok', database: 'ok' };
  }
}
