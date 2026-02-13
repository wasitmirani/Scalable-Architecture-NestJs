import { Module, MiddlewareConsumer, NestModule, RequestMethod } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { User } from './entities/user.entity';

import { AdvancedFileLogger } from 'src/services/logger.service';
import { AuthMiddleware } from 'src/middleware/auth/auth.middleware';

@Module({
  // Register User entity for dependency injection
  imports: [TypeOrmModule.forFeature([User])],

  // Controller responsible for handling HTTP requests
  controllers: [UsersController],

  // Services available inside this module
  providers: [UsersService, AdvancedFileLogger],

  // Export services if other modules need them
  exports: [UsersService, TypeOrmModule],
})
export class UsersModule implements NestModule {

  /**
   * configure() allows us to bind middleware
   * only to specific routes inside this module
   */
  configure(consumer: MiddlewareConsumer) {

    consumer
      .apply(AuthMiddleware) // Apply authentication middleware
      .exclude(
        // Exclude public routes (example: login & register)
        { path: 'users/login', method: RequestMethod.POST },
        { path: 'users/register', method: RequestMethod.POST },
      )
      .forRoutes(
        // Protect all other routes in UsersController
        UsersController,
      );
  }
}
