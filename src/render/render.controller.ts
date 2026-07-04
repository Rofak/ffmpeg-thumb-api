import {
  Controller,
  Post,
  Get,
  Delete,
  Param,
  Body,
  BadRequestException,
  NotFoundException,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { RenderService } from './render.service';
import { RenderJobData } from './render.processor';
import { RenderUrlDto } from './dto/render-url.dto';
import { DubVideoDto } from './dto/dub-video.dto';
import { getCpuCount, getRenderConcurrency } from './render-concurrency';
import { randomUUID as uuidv4 } from 'crypto';

@ApiTags('render')
@Controller('render')
export class RenderController {
  constructor(
    private readonly renderService: RenderService,
    @InjectQueue('render') private readonly renderQueue: Queue<RenderJobData>,
  ) {}

  @Post('/url/:userId')
  @ApiOperation({
    summary: 'Queue a render job from a remote video + audio URL',
  })
  @ApiParam({ name: 'userId', description: 'Owner of the render output' })
  @ApiBody({ type: RenderUrlDto })
  @ApiResponse({ status: 201, schema: { example: { jobId: 'uuid' } } })
  async renderFromUrls(
    @Param('userId') userId: string,
    @Body('videoUrl') videoUrl: string,
    @Body('audioUrl') audioUrl: string,
  ) {
    if (!videoUrl || !audioUrl) {
      throw new BadRequestException('videoUrl and audioUrl are required');
    }
    const jobId = uuidv4();
    const job = await this.renderQueue.add(
      'render',
      {
        type: 'url',
        userId,
        videoUrl,
        audioUrl,
      },
      { jobId },
    );
    return { jobId: job.id };
  }

  @Post('/:userId')
  @ApiOperation({
    summary: 'Queue a render job from uploaded video + audio files',
  })
  @ApiParam({ name: 'userId', description: 'Owner of the render output' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        video: { type: 'string', format: 'binary' },
        audio: { type: 'string', format: 'binary' },
      },
    },
  })
  @ApiResponse({ status: 201, schema: { example: { jobId: 'uuid' } } })
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: 'video', maxCount: 1 },
      { name: 'audio', maxCount: 1 },
    ]),
  )
  async renderFromUpload(
    @Param('userId') userId: string,
    @UploadedFiles()
    files: { video?: any[]; audio?: any[] },
  ) {
    const video = files?.video?.[0];
    const audio = files?.audio?.[0];
    if (!video || !audio) {
      throw new BadRequestException('video and audio files are required');
    }
    const { videoPath, audioPath } = this.renderService.persistUploadedFiles(
      video.buffer,
      audio.buffer,
    );
    const jobId = uuidv4();
    await this.renderQueue.add(
      'render',
      {
        type: 'buffer',
        userId,
        videoPath,
        audioPath,
      },
      { jobId },
    );
    return { jobId };
  }

  @Post('/dub/:userId')
  @ApiOperation({
    summary:
      'Queue a dubbed-video render: time-stretch + position each base64 audio segment over the original video, mix them, and return both the dubbed video and the dubbed audio track alone',
  })
  @ApiParam({ name: 'userId', description: 'Owner of the render output' })
  @ApiBody({ type: DubVideoDto })
  @ApiResponse({ status: 201, schema: { example: { jobId: 'uuid' } } })
  async renderDub(@Param('userId') userId: string, @Body() dto: DubVideoDto) {
    if (!dto?.originVideoUrl || !dto?.segments?.length) {
      throw new BadRequestException('originVideoUrl and segments are required');
    }
    const segments = this.renderService.persistDubSegments(dto.segments);
    const jobId = uuidv4();
    await this.renderQueue.add(
      'render',
      {
        type: 'dub',
        userId,
        videoUrl: dto.originVideoUrl,
        segments,
      },
      { jobId },
    );
    return { jobId };
  }

  @Get('/concurrency')
  @ApiOperation({
    summary:
      'Report render concurrency capacity and how much of it is free right now',
  })
  @ApiResponse({
    status: 200,
    schema: {
      example: {
        cpuCount: 8,
        renderConcurrencyEnv: null,
        effectiveConcurrency: 8,
        active: 3,
        waiting: 5,
        delayed: 0,
        remainingConcurrency: 5,
      },
    },
  })
  async getConcurrency() {
    const envValue = process.env.RENDER_CONCURRENCY
      ? Number(process.env.RENDER_CONCURRENCY)
      : null;
    const effectiveConcurrency = getRenderConcurrency();
    const { active, waiting, delayed } = await this.renderQueue.getJobCounts(
      'active',
      'waiting',
      'delayed',
    );
    return {
      cpuCount: getCpuCount(),
      renderConcurrencyEnv: envValue,
      effectiveConcurrency,
      active,
      waiting,
      delayed,
      remainingConcurrency: Math.max(effectiveConcurrency - active, 0),
    };
  }

  @Get('/status/:jobId')
  @ApiOperation({ summary: 'Get the state/result of a queued render job' })
  @ApiParam({
    name: 'jobId',
    description: 'jobId returned by the enqueue call',
  })
  @ApiResponse({
    status: 200,
    schema: {
      example: {
        jobId: 'uuid',
        state: 'active',
        progress: 42,
        result: null,
        failedReason: null,
      },
    },
  })
  async getStatus(@Param('jobId') jobId: string) {
    const job = await this.renderQueue.getJob(jobId);
    if (!job) {
      throw new NotFoundException(`Job ${jobId} not found`);
    }
    const state = await job.getState();
    return {
      jobId: job.id,
      state,
      progress: typeof job.progress === 'number' ? job.progress : 0,
      result: job.returnvalue ?? null,
      failedReason: job.failedReason ?? null,
    };
  }

  @Delete('/:userId')
  @ApiOperation({ summary: 'Delete all rendered outputs for a user' })
  @ApiParam({ name: 'userId', description: 'Owner whose renders are deleted' })
  async deleteRender(@Param('userId') userId: string) {
    return this.renderService.deleteRender(userId);
  }
}
