import { Module } from '@nestjs/common';
import { ThumbnailModule } from '../thumbnail/thumbnail.module';

@Module({
  imports: [ThumbnailModule],
})
export class ScheduleTaskModule {}
