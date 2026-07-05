import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';

// express-basic-auth uses `export =` (plain CJS `module.exports = fn`, no
// `.default`); without esModuleInterop, `import x from` compiles to a
// `.default` access that doesn't exist, so use the `import x = require()`
// form instead, which matches the module's actual runtime shape.
import basicAuth = require('express-basic-auth');

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.use(json({ limit: '100mb' }));
  app.use(urlencoded({ limit: '100mb', extended: true }));
  app.enableCors({
    origin: ['https://similartoolz.net', 'http://localhost:3000'],
    methods: ['GET', 'DELETE'],
    allowedHeaders: 'Content-Type, Authorization',
    credentials: true,
  });

  // Swagger docs and the BullMQ dashboard have no auth of their own -
  // gate both behind the same basic-auth credentials at the app level
  // (in addition to/independent of any nginx-level auth_basic).
  app.use(
    ['/docs', '/queues'],
    basicAuth({
      users: {
        [process.env.ADMIN_USER || 'admin']:
          process.env.ADMIN_PASSWORD || 'changeme',
      },
      challenge: true,
    }),
  );

  const config = new DocumentBuilder()
    .setTitle('FFmpeg API')
    .setDescription('Thumbnail extraction and video/audio render API')
    .setVersion('1.0')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);

  await app.listen(3002);
}
bootstrap();
