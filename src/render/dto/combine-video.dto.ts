import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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

  @ApiPropertyOptional({
    example: 'https://example.com/webhook',
    description:
      'Optional URL POSTed with { jobId, status: "completed" | "failed", result?, error? } once the job settles.',
  })
  webhookUrl?: string;
}
