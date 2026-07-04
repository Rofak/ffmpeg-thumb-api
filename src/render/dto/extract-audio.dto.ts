import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ExtractAudioDto {
  @ApiProperty({ example: 'https://example.com/video.mp4' })
  videoUrl: string;

  @ApiPropertyOptional({
    example: 128,
    description: 'Output MP3 bitrate in kbps (default 128)',
  })
  bitrateKbps?: number;
}
