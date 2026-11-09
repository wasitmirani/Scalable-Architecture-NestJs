import { MiddlewareConsumer, Module, RequestMethod } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { LoggingMiddleware } from './common/middleware/logging.middleware';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { AuthGuard } from './common/guards/jwt-auth.guard';
import { PermissionsGuard } from './common/guards/roles.guard';
import { validateEnv } from './config/configuration';
import mailConfig from './config/mail.config';
import { DatabaseConnection } from './database/database.connection';
import { DatabaseModule } from './database/database.module';
import { AccessModule } from './modules/access/access.module';
import { ApiKeysModule } from './modules/api-keys/api-keys.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { InvitationsModule } from './modules/invitations/invitations.module';
import { MailModule } from './modules/mail/mail.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { UsersModule } from './modules/users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      load: [mailConfig],
    }),
    DatabaseConnection,
    DatabaseModule,
    AuditModule,
    MailModule,
    AccessModule,
    TenantsModule,
    InvitationsModule,
    ApiKeysModule,
    UsersModule,
    AuthModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Order matters: authenticate first, then resolve tenant + permissions.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(RequestIdMiddleware, LoggingMiddleware)
      .forRoutes({ path: '*path', method: RequestMethod.ALL });
  }
}
