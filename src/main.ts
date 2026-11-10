import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp, setupSwagger } from './app.setup';
import { AdvancedFileLogger } from './services/logger.service';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: new AdvancedFileLogger(),
    // Incoming workflow webhooks verify HMAC signatures against the exact bytes received.
    rawBody: true,
  });
  // Contact imports send parsed CSV rows; Express's 100 KB default is too small.
  app.useBodyParser('json', { limit: '10mb' });
  configureApp(app);
  setupSwagger(app);
  app.enableShutdownHooks();

  await app.listen(process.env.PORT ?? 8888);
  console.log(`Application is running on: ${await app.getUrl()}`);
}
void bootstrap();
