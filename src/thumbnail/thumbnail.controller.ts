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
import {
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

@ApiTags('thumbnail')
@Controller('thumbnail')
export class ThumbnailController {
  constructor(private readonly thumbnailService: ThumbnailService) {}

  @Get('/:userId')
  @ApiOperation({
    summary: 'Extract 3 thumbnail frames from a remote video URL',
  })
  @ApiParam({ name: 'userId', description: 'Owner of the thumbnails' })
  @ApiQuery({ name: 'url', description: 'Remote video URL' })
  async getThumb(@Param('userId') userId: string, @Query('url') url: string) {
    if (!url) {
      throw new BadRequestException('url is required');
    }
    return await this.thumbnailService.generate(userId, url);
  }

  @Delete('/cleanup')
  @ApiOperation({
    summary: 'Sweep thumbnails/ and delete objects older than 1 hour',
  })
  async cleanupOldThumbs() {
    return this.thumbnailService.clearOldThumbnails();
  }

  @Post('/upload/:userId')
  @ApiOperation({
    summary: 'Extract 3 thumbnail frames from an uploaded video',
  })
  @ApiParam({ name: 'userId', description: 'Owner of the thumbnails' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @UseInterceptors(FileInterceptor('file'))
  async generate(@Param('userId') userId: string, @UploadedFile() file: any) {
    return this.thumbnailService.thumbFromBufferToS3(file.buffer, userId);
  }

  @Delete('/:userId')
  @ApiOperation({ summary: 'Delete all thumbnails for a user' })
  @ApiParam({
    name: 'userId',
    description: 'Owner whose thumbnails are deleted',
  })
  async deleteThumb(@Param('userId') userId: string) {
    return this.thumbnailService.deleteThumb(userId);
  }
}
