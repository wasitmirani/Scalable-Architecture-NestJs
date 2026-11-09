import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';

/** HTTP configuration shared by main.ts and the e2e tests. */
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix(process.env.API_PREFIX || 'api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());

  app.enableCors({
    origin: (process.env.ALLOWED_ORIGINS || 'http://localhost:5173')
      .split(',')
      .map((o) => o.trim()),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'X-Tenant-Id',
      'X-Api-Key',
      'X-Request-Id',
      'Idempotency-Key',
    ],
    exposedHeaders: ['X-Request-Id'],
    credentials: true,
  });
}

export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle(process.env.APP_NAME || 'BirdCRM API')
    .setDescription(
      'Core API. Authenticate with `Authorization: Bearer <access token>` or `X-Api-Key`. ' +
        'Workspace-scoped endpoints take the workspace from `:tenantId` or the `X-Tenant-Id` header.',
    )
    .setVersion('1')
    .addBearerAuth()
    .addApiKey({ type: 'apiKey', in: 'header', name: 'X-Api-Key' }, 'api-key')
    .addGlobalParameters({
      in: 'header',
      name: 'X-Tenant-Id',
      required: false,
      schema: { type: 'string', format: 'uuid' },
    })
    .addSecurityRequirements('bearer')
    .addSecurityRequirements('api-key')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup(
    `${process.env.API_PREFIX || 'api'}/v1/docs`,
    app,
    document,
  );
}
