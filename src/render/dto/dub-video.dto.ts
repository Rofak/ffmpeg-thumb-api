import { ApiProperty } from '@nestjs/swagger';

export class DubSegmentDto {
  @ApiProperty({ description: 'Base64-encoded TTS audio for this segment' })
  audio: string;

  @ApiProperty({
    example: '9.914',
    description: 'Segment start time in seconds',
  })
  start: string;

  @ApiProperty({
    example: '11.714',
    description: 'Segment end time in seconds',
  })
  end: string;
}

export class DubVideoDto {
  @ApiProperty({ example: 'https://example.com/video.mp4' })
  originVideoUrl: string;

  @ApiProperty({ type: [DubSegmentDto] })
  segments: DubSegmentDto[];
}
