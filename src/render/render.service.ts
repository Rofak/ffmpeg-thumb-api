import { Injectable } from '@nestjs/common';
import * as fs from 'fs-extra';
import { spawn } from 'child_process';
import axios from 'axios';
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import {
  writeFileSync,
  unlinkSync,
  createWriteStream,
  createReadStream,
  statSync,
} from 'fs';

@Injectable()
export class RenderService {
  private s3Client: S3Client;
  private readonly bucketName: string;
  private readonly baseUrl: string;

  constructor(private configService: ConfigService) {
    this.bucketName = this.configService.get<string>('CONTABO_BUCKET_NAME_V2');
    this.baseUrl = `${this.configService.get<string>('CONTABO_BASE_URL_V2')}:${this.bucketName}`;
    this.s3Client = new S3Client({
      region: 'auto',
      endpoint: configService.get<string>('CONTABO_ENDPOIN_V2'),
      credentials: {
        accessKeyId: configService.get<string>('CONTABO_ACCESS_KEY_V2'),
        secretAccessKey: configService.get<string>('CONTABO_SECRET_KEY_V2'),
      },
      forcePathStyle: true,
    } as any);
  }

  private runFFmpeg(
    args: string[],
    onProgress?: (percent: number) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', args);
      let stderr = '';
      let durationSeconds: number | null = null;

      ffmpeg.stderr.on('data', (chunk) => {
        stderr += chunk;
        if (!onProgress) return;

        if (durationSeconds === null) {
          const durationMatch = stderr.match(
            /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/,
          );
          if (durationMatch) {
            durationSeconds =
              Number(durationMatch[1]) * 3600 +
              Number(durationMatch[2]) * 60 +
              Number(durationMatch[3]);
          }
        }

        if (durationSeconds) {
          const timeMatches = [
            ...stderr.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g),
          ];
          const last = timeMatches[timeMatches.length - 1];
          if (last) {
            const currentSeconds =
              Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]);
            const percent = Math.min(
              99,
              Math.max(0, Math.round((currentSeconds / durationSeconds) * 100)),
            );
            onProgress(percent);
          }
        }
      });

      ffmpeg.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`FFmpeg exited with code ${code}: ${stderr}`));
      });
    });
  }

  private mergeArgs(
    videoInput: string,
    audioInput: string,
    outputPath: string,
  ) {
    return [
      '-y',
      '-i',
      videoInput,
      '-i',
      audioInput,
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-shortest',
      outputPath,
    ];
  }

  private async downloadToFile(url: string, destPath: string): Promise<void> {
    const response = await axios.get(url, { responseType: 'stream' });
    const writer = createWriteStream(destPath);
    return new Promise((resolve, reject) => {
      response.data.pipe(writer);
      writer.on('finish', resolve);
      writer.on('error', reject);
      response.data.on('error', reject);
    });
  }

  private async uploadFileToS3(
    filePath: string,
    key: string,
    contentType: string,
    disposition: 'attachment' | 'inline' = 'attachment',
  ) {
    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: createReadStream(filePath),
        ContentLength: statSync(filePath).size,
        ContentType: contentType,
        ContentDisposition: `${disposition}; filename="${path.basename(key)}"`,
        ACL: 'public-read',
      }) as any,
    );
    return { uri: `${this.baseUrl}/${key}` };
  }

  private async uploadToS3(filePath: string, userId: string) {
    const key = `renders/${userId}/${randomUUID()}.mp4`;
    return this.uploadFileToS3(filePath, key, 'video/mp4');
  }

  private getDuration(filePath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const ffprobe = spawn('ffprobe', [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        filePath,
      ]);
      let stdout = '';
      let stderr = '';
      ffprobe.stdout.on('data', (chunk) => (stdout += chunk));
      ffprobe.stderr.on('data', (chunk) => (stderr += chunk));
      ffprobe.on('close', (code) => {
        if (code === 0) resolve(parseFloat(stdout.trim()) || 0);
        else reject(new Error(`ffprobe exited with code ${code}: ${stderr}`));
      });
    });
  }

  private buildAtempoChain(tempo: number): string {
    if (tempo <= 0) {
      return 'atempo=1.0';
    }
    // force normal speed if below 1
    if (tempo < 1.0) {
      return 'atempo=1.0';
    }
    // clamp upper limit only
    const clamped = Math.min(tempo, 1.8);
    return `atempo=${clamped.toFixed(5)}`;
  }

  async renderFromUrls(
    userId: string,
    videoUrl: string,
    audioUrl: string,
    onProgress?: (percent: number) => void,
  ) {
    const tmpDir = path.join(process.cwd(), 'tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);

    const videoPath = path.join(tmpDir, `video_${randomUUID()}.mp4`);
    const audioPath = path.join(tmpDir, `audio_${randomUUID()}.mp3`);

    try {
      await Promise.all([
        this.downloadToFile(videoUrl, videoPath),
        this.downloadToFile(audioUrl, audioPath),
      ]);
    } catch (err) {
      if (fs.existsSync(videoPath)) unlinkSync(videoPath);
      if (fs.existsSync(audioPath)) unlinkSync(audioPath);
      throw err;
    }
    onProgress?.(5);

    return this.renderFromPaths(userId, videoPath, audioPath, onProgress);
  }

  persistUploadedFiles(videoBuffer: Buffer, audioBuffer: Buffer) {
    const tmpDir = path.join(process.cwd(), 'tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);

    const videoPath = path.join(tmpDir, `video_${randomUUID()}.mp4`);
    const audioPath = path.join(tmpDir, `audio_${randomUUID()}.mp3`);

    writeFileSync(videoPath, videoBuffer);
    writeFileSync(audioPath, audioBuffer);

    return { videoPath, audioPath };
  }

  async renderFromPaths(
    userId: string,
    videoPath: string,
    audioPath: string,
    onProgress?: (percent: number) => void,
  ) {
    const tmpDir = path.join(process.cwd(), 'tmp');
    const outputPath = path.join(tmpDir, `render_${randomUUID()}.mp4`);

    try {
      onProgress?.(10);
      await this.runFFmpeg(
        this.mergeArgs(videoPath, audioPath, outputPath),
        onProgress &&
          ((percent) => onProgress(10 + Math.round(percent * 0.85))),
      );
      const result = await this.uploadToS3(outputPath, userId);
      onProgress?.(100);
      return result;
    } finally {
      if (fs.existsSync(outputPath)) unlinkSync(outputPath);
      if (fs.existsSync(videoPath)) unlinkSync(videoPath);
      if (fs.existsSync(audioPath)) unlinkSync(audioPath);
    }
  }

  persistDubSegments(
    segments: { audio: string; start: string; end: string }[],
  ) {
    const tmpDir = path.join(process.cwd(), 'tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);

    return segments.map((seg) => {
      const audioPath = path.join(tmpDir, `seg_${randomUUID()}.mp3`);
      writeFileSync(audioPath, Buffer.from(seg.audio, 'base64'));
      return {
        audioPath,
        start: Number(seg.start),
        end: Number(seg.end),
      };
    });
  }

  async renderDubbedVideo(
    userId: string,
    videoUrl: string,
    segments: { audioPath: string; start: number; end: number }[],
    onProgress?: (percent: number) => void,
    accompanimentAudioUrl?: string,
  ) {
    const tmpDir = path.join(process.cwd(), 'tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);

    const videoPath = path.join(tmpDir, `video_${randomUUID()}.mp4`);
    const outputVideoPath = path.join(tmpDir, `dub_video_${randomUUID()}.mp4`);
    const outputAudioPath = path.join(tmpDir, `dub_audio_${randomUUID()}.m4a`);
    const thumbnailPath = path.join(tmpDir, `dub_thumb_${randomUUID()}.jpg`);
    const accompanimentPath = accompanimentAudioUrl
      ? path.join(tmpDir, `accompaniment_${randomUUID()}.mp3`)
      : null;
    const cleanupPaths = [
      videoPath,
      outputVideoPath,
      outputAudioPath,
      thumbnailPath,
      ...segments.map((s) => s.audioPath),
      ...(accompanimentPath ? [accompanimentPath] : []),
    ];

    try {
      await this.downloadToFile(videoUrl, videoPath);
      if (accompanimentPath) {
        await this.downloadToFile(accompanimentAudioUrl, accompanimentPath);
      }
      onProgress?.(5);

      const videoDuration = await this.getDuration(videoPath);

      const inputs: string[] = [];

      // If an accompaniment track (e.g. the original background
      // music/ambience) is provided, dubbed segments are mixed on top of it
      // instead of over silence, so it survives in the final dub. Padded
      // with `apad` the same way the silence bed is, so a track shorter
      // than the video doesn't cut the mix short - the final `-t
      // videoDuration` below bounds it either way.
      let baseFilter =
        'anullsrc=channel_layout=stereo:sample_rate=44100,apad[base]';
      if (accompanimentPath) {
        const accompanimentIdx = inputs.length + 1;
        inputs.push(accompanimentPath);
        // volume=0.5 so the background track sits under the dubbed voice
        // segments instead of competing with them.
        baseFilter = `[${accompanimentIdx}:a]aformat=sample_rates=44100:channel_layouts=stereo,aresample=44100,volume=0.2,apad[base]`;
      }

      const filterParts = [baseFilter];
      const mixLabels = ['[base]'];

      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const start = Math.max(seg.start, 0);
        const end = Math.max(seg.end, start + 0.05);
        const targetDur = end - start;
        const originalDur = await this.getDuration(seg.audioPath);
        if (originalDur <= 0) continue;

        const tempo = originalDur / targetDur;
        const atempo = this.buildAtempoChain(tempo);
        const delayMs = Math.round(start * 1000);
        const inputIdx = inputs.length + 1;
        const label = `v_a${i}`;

        filterParts.push(
          `[${inputIdx}:a]aformat=sample_rates=44100:channel_layouts=stereo,aresample=44100,${atempo},adelay=${delayMs}|${delayMs}[${label}]`,
        );
        mixLabels.push(`[${label}]`);
        inputs.push(seg.audioPath);
      }

      if (mixLabels.length === 1) {
        throw new Error('No valid audio segments to dub');
      }

      filterParts.push(
        `${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=longest:dropout_transition=0:normalize=0,volume=2[aout]`,
      );

      onProgress?.(10);

      // Mixing and remuxing are done as two separate ffmpeg invocations
      // (rather than one command fanning the mix out to two output files via
      // asplit) because some ffmpeg builds hang indefinitely finalizing two
      // simultaneous output muxers fed from a shared filtergraph.
      const mixArgs = ['-y', '-i', videoPath];
      for (const inputPath of inputs) {
        mixArgs.push('-i', inputPath);
      }
      mixArgs.push(
        '-filter_complex',
        filterParts.join(';'),
        '-map',
        '[aout]',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-ar',
        '44100',
        '-ac',
        '2',
        '-t',
        String(videoDuration),
        outputAudioPath,
      );

      await this.runFFmpeg(
        mixArgs,
        onProgress && ((percent) => onProgress(10 + Math.round(percent * 0.6))),
      );

      await this.runFFmpeg(
        [
          '-y',
          '-i',
          videoPath,
          '-i',
          outputAudioPath,
          '-map',
          '0:v',
          '-map',
          '1:a',
          '-c:v',
          'copy',
          '-c:a',
          'copy',
          '-shortest',
          outputVideoPath,
        ],
        onProgress && (() => onProgress(70)),
      );

      await this.runFFmpeg([
        '-y',
        '-i',
        outputVideoPath,
        '-frames:v',
        '1',
        '-q:v',
        '2',
        thumbnailPath,
      ]);
      onProgress?.(85);

      const [videoResult, audioResult, thumbnailResult] = await Promise.all([
        this.uploadToS3(outputVideoPath, userId),
        this.uploadFileToS3(
          outputAudioPath,
          `renders/${userId}/${randomUUID()}.m4a`,
          'audio/mp4',
        ),
        this.uploadFileToS3(
          thumbnailPath,
          `renders/${userId}/${randomUUID()}.jpg`,
          'image/jpeg',
          'inline',
        ),
      ]);
      onProgress?.(100);

      return {
        videoUri: videoResult.uri,
        audioUri: audioResult.uri,
        thumbnailUri: thumbnailResult.uri,
      };
    } finally {
      for (const p of cleanupPaths) {
        if (fs.existsSync(p)) unlinkSync(p);
      }
    }
  }

  async extractAudioFromUrl(
    userId: string,
    videoUrl: string,
    bitrateKbps = 128,
    onProgress?: (percent: number) => void,
  ) {
    const tmpDir = path.join(process.cwd(), 'tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);

    const videoPath = path.join(tmpDir, `video_${randomUUID()}.mp4`);
    const outputPath = path.join(tmpDir, `audio_${randomUUID()}.mp3`);

    try {
      await this.downloadToFile(videoUrl, videoPath);
      onProgress?.(10);

      await this.runFFmpeg(
        [
          '-y',
          '-i',
          videoPath,
          '-vn',
          '-c:a',
          'libmp3lame',
          '-b:a',
          `${bitrateKbps}k`,
          '-ar',
          '44100',
          '-ac',
          '2',
          outputPath,
        ],
        onProgress &&
          ((percent) => onProgress(10 + Math.round(percent * 0.85))),
      );

      const result = await this.uploadFileToS3(
        outputPath,
        `renders/${userId}/${randomUUID()}.mp3`,
        'audio/mpeg',
      );
      onProgress?.(100);
      return result;
    } finally {
      if (fs.existsSync(videoPath)) unlinkSync(videoPath);
      if (fs.existsSync(outputPath)) unlinkSync(outputPath);
    }
  }

  async deleteRender(userId: string) {
    const prefix = `renders/${userId}/`;
    const listed: any = await this.s3Client.send(
      new ListObjectsV2Command({
        Bucket: this.bucketName,
        Prefix: prefix,
      }) as any,
    );

    if (!listed.Contents || listed.Contents.length === 0) {
      return { totalDeleted: 0 };
    }

    const objects = listed.Contents.map((obj) => ({ Key: obj.Key }));

    const response: any = await this.s3Client.send(
      new DeleteObjectsCommand({
        Bucket: this.bucketName,
        Delete: { Objects: objects },
      }) as any,
    );
    return { totalDeleted: response.Deleted.length };
  }
}
