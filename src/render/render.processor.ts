import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { RenderService } from './render.service';
import { getRenderConcurrency } from './render-concurrency';

export type RenderJobData =
  | { type: 'url'; userId: string; videoUrl: string; audioUrl: string }
  | { type: 'buffer'; userId: string; videoPath: string; audioPath: string }
  | {
      type: 'dub';
      userId: string;
      videoUrl: string;
      segments: { audioPath: string; start: number; end: number }[];
    }
  | {
      type: 'extract-audio';
      userId: string;
      videoUrl: string;
      bitrateKbps?: number;
    };

@Processor('render', {
  concurrency: getRenderConcurrency(),
  lockDuration: 10 * 60 * 1000,
})
export class RenderProcessor extends WorkerHost {
  constructor(private readonly renderService: RenderService) {
    super();
  }

  async process(job: Job<RenderJobData>) {
    const onProgress = (percent: number) => {
      job.updateProgress(percent).catch(() => undefined);
    };

    const data = job.data;
    if (data.type === 'url') {
      return this.renderService.renderFromUrls(
        data.userId,
        data.videoUrl,
        data.audioUrl,
        onProgress,
      );
    }
    if (data.type === 'dub') {
      return this.renderService.renderDubbedVideo(
        data.userId,
        data.videoUrl,
        data.segments,
        onProgress,
      );
    }
    if (data.type === 'extract-audio') {
      return this.renderService.extractAudioFromUrl(
        data.userId,
        data.videoUrl,
        data.bitrateKbps,
        onProgress,
      );
    }
    return this.renderService.renderFromPaths(
      data.userId,
      data.videoPath,
      data.audioPath,
      onProgress,
    );
  }
}
