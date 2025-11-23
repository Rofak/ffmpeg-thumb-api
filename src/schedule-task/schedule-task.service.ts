import { Injectable, Logger } from '@nestjs/common';
// import { Cron, CronExpression } from '@nestjs/schedule';
import { ThumbnailService } from '../thumbnail/thumbnail.service';

@Injectable()
export class ScheduleTaskService {
  private readonly logger = new Logger(ScheduleTaskService.name);

  constructor(private thumbnailService: ThumbnailService) {}

  // @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  // async handleCron() {
  //   this.logger.debug('start clear old thumbnail');
  //   const res = await this.thumbnailService.clearOldThumbnails();
  //   this.logger.debug(`end clear old thumbnail, total clear ${res.removed}`);
  // }
}
