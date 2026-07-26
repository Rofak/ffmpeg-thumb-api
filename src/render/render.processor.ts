import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { RenderService } from './render.service';
import { getRenderConcurrency } from './render-concurrency';

export type RenderJobData = (
  | { type: 'url'; userId: string; videoUrl: string; audioUrl: string }
  | { type: 'buffer'; userId: string; videoPath: string; audioPath: string }
  | {
      type: 'dub';
      userId: string;
      videoUrl: string;
      segments: { audioPath: string; start: number; end: number }[];
      accompanimentAudioUrl?: string;
    }
  | {
      type: 'extract-audio';
      userId: string;
      videoUrl: string;
      bitrateKbps?: number;
    }
  | { type: 'combine-video'; userId: string; videoUrls: string[] }
) & {
  // Fired with { jobId, status: 'completed' | 'failed', result?, error? }
  // once the job settles. Best-effort: a failed delivery does not fail the job.
  webhookUrl?: string;
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
    try {
      const result = await this.runJob(data, onProgress);
      if (data.webhookUrl) {
        await this.renderService.notifyWebhook(data.webhookUrl, {
          jobId: job.id,
          status: 'completed',
          result,
        });
      }
      return result;
    } catch (err) {
      if (data.webhookUrl) {
        await this.renderService.notifyWebhook(data.webhookUrl, {
          jobId: job.id,
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
      throw err;
    }
  }

  private runJob(data: RenderJobData, onProgress: (percent: number) => void) {
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
        data.accompanimentAudioUrl,
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
    if (data.type === 'combine-video') {
      return this.renderService.combineVideosFromUrls(
        data.userId,
        data.videoUrls,
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
