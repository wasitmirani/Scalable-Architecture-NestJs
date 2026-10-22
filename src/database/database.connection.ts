import 'reflect-metadata';
import { TypeOrmModule } from '@nestjs/typeorm';
import { dbOptions } from './typeorm.config';

export const DatabaseConnection = TypeOrmModule.forRoot({
  ...dbOptions,
  autoLoadEntities: true,
});

export default DatabaseConnection;
