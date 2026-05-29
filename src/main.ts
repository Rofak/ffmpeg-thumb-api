import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: ['https://similartoolz.net', 'http://localhost:3000'],
    methods: ['GET', 'DELETE'],
    allowedHeaders: 'Content-Type, Authorization',
    credentials: true,
  });
  await app.listen(3001);
}
bootstrap();
