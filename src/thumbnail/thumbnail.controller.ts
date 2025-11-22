import {
  Controller,
  Get,
  Query,
  BadRequestException,
  Param,
  Delete,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { ThumbnailService } from './thumbnail.service';
import { FileInterceptor } from '@nestjs/platform-express';

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

  @Post('/upload/:userId')
  @UseInterceptors(FileInterceptor('file'))
  async generate(@Param('userId') userId: string, @UploadedFile() file: any) {
    return this.thumbnailService.thumbFromBufferToS3(file.buffer, userId);
  }
}
