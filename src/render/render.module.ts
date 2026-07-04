import { Module } from '@nestjs/common';
import { RenderController } from './render.controller';
import { RenderService } from './render.service';
import { RenderProcessor } from './render.processor';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';

@Module({
  imports: [
    ConfigModule,
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('REDIS_HOST', 'localhost'),
          port: config.get<number>('REDIS_PORT', 6379),
          password: config.get<string>('REDIS_PASSWORD') || undefined,
          maxRetriesPerRequest: null,
        },
      }),
    }),
    BullModule.registerQueue({
      name: 'render',
      defaultJobOptions: {
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 100 },
      },
    }),
  ],
  controllers: [RenderController],
  providers: [RenderService, RenderProcessor],
  exports: [RenderService],
})
export class RenderModule {}
