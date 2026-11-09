import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp, setupSwagger } from './app.setup';
import { AdvancedFileLogger } from './services/logger.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: new AdvancedFileLogger(),
  });
  configureApp(app);
  setupSwagger(app);
  app.enableShutdownHooks();

  await app.listen(process.env.PORT ?? 8888);
  console.log(`Application is running on: ${await app.getUrl()}`);
}
void bootstrap();
