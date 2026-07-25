import { ApiProperty } from '@nestjs/swagger';

export class CombineVideoDto {
  @ApiProperty({
    type: [String],
    example: [
      'https://example.com/clip1.mp4',
      'https://example.com/clip2.mp4',
    ],
    description:
      'Video clip URLs, in the order they should be concatenated. At least 2 required.',
  })
  videoUrls: string[];
}
