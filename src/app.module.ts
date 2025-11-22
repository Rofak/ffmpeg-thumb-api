import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ThumbnailModule } from './thumbnail/thumbnail.module';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ScheduleTaskService } from './schedule-task/schedule-task.service';
import { ScheduleTaskModule } from './schedule-task/schedule-task.module';

@Module({
  imports: [
    ThumbnailModule,
    ConfigModule.forRoot(),
    ScheduleModule.forRoot(),
    ScheduleTaskModule,
  ],
  controllers: [AppController],
  providers: [AppService, ScheduleTaskService],
})
export class AppModule {}
