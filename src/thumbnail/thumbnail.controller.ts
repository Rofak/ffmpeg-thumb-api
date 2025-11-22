import {
  Controller,
  Get,
  Query,
  BadRequestException,
  Param,
  Delete,
} from '@nestjs/common';
import { ThumbnailService } from './thumbnail.service';

@Controller('thumbnail')
export class ThumbnailController {
  constructor(private readonly thumbnailService: ThumbnailService) {}

  @Get('/:userId')
  async getThumb(@Param('userId') userId: string, @Query('url') url: string) {
    if (!url) {
      throw new BadRequestException('url is required');
    }
    return await this.thumbnailService.generate(userId, url);
  }

  @Delete('/cleanup')
  async cleanupOldThumbs() {
    return this.thumbnailService.clearOldThumbnails();
  }
}
