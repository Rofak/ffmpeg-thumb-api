import { ApiProperty } from '@nestjs/swagger';

export class RenderUrlDto {
  @ApiProperty({ example: 'https://example.com/video.mp4' })
  videoUrl: string;

  @ApiProperty({ example: 'https://example.com/audio.mp3' })
  audioUrl: string;
}
