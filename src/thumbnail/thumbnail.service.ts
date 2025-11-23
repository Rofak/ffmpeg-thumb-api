import { Injectable } from '@nestjs/common';
import * as fs from 'fs-extra';
import { exec } from 'child_process';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { writeFileSync, unlinkSync, readFileSync } from 'fs';
import { spawn } from 'child_process';

@Injectable()
export class ThumbnailService {
  private s3Client: S3Client;
  private readonly bucketName: string;
  private readonly baseUrl: string;
  constructor(private configService: ConfigService) {
    this.bucketName = this.configService.get<string>('CONTABO_BUCKET_NAME');
    this.baseUrl = this.configService.get<string>('CONTABO_BASE_URL');
    this.s3Client = new S3Client({
      region: 'sin1',
      endpoint: configService.get<string>('CONTABO_ENDPOIN'),
      credentials: {
        accessKeyId: configService.get<string>('CONTABO_ACCESS_KEY'),
        secretAccessKey: configService.get<string>('CONTABO_SECRET_KEY'),
      },
      forcePathStyle: true,
    } as any);
  }

  async generate(userId, videoUrl: string) {
    const thumbnail: any = [];
    const tmpDir = path.join(process.cwd(), 'tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);

    for (let i = 0; i < 3; i++) {
      try {
        const tempPath = path.join(
          process.cwd(),
          'tmp',
          `thumb_${randomUUID()}.jpg`,
        );
        await new Promise((resolve, reject) => {
          const cmd = `ffmpeg -ss ${i} -i "${videoUrl}" -frames:v 1 -q:v 2 ${tempPath}`;
          exec(cmd, (err) => (err ? reject(err) : resolve(true)));
        });

        // Upload to S3
        const buffer = await fs.readFile(tempPath);
        const key = `thumbnails/${userId}/${randomUUID()}.jpg`;

        await this.s3Client.send(
          new PutObjectCommand({
            Bucket: this.bucketName,
            Key: key,
            Body: buffer,
            ContentType: 'image/jpeg',
            ACL: 'public-read',
          }) as any,
        );

        thumbnail.push({
          uri: `${this.baseUrl}/${key}`,
        });
        await fs.unlink(tempPath, () => {});
      } catch (err) {
        console.error('Thumbnail generation failed:', err);
      }
    }
    return thumbnail;
  }

  async clearOldThumbnails() {
    const prefix = 'thumbnails/';
    const list: any = await this.s3Client.send(
      new ListObjectsV2Command({
        Bucket: this.bucketName,
        Prefix: prefix,
      }) as any,
    );

    if (!list.Contents) return { removed: 0 };

    const now = Date.now();
    // const oneDay = 24 * 60 * 60 * 1000;
    // const halfDay = 12 * 60 * 60 * 1000;
    // const oneMinute = 60 * 1000;
    const oneHour = 60 * 60 * 1000; // 1 hour in milliseconds

    let deleted = 0;

    // 2. Loop through each thumbnail
    for (const file of list.Contents) {
      if (!file.LastModified || !file.Key) continue;

      const fileAge = now - new Date(file.LastModified).getTime();

      // If older than 1 day → delete
      if (fileAge > oneHour) {
        await this.s3Client.send(
          new DeleteObjectCommand({
            Bucket: this.bucketName,
            Key: file.Key,
          }) as any,
        );
        deleted++;
      }
    }

    return { removed: deleted };
  }

  async thumbFromBufferToS3(buffer: any, userId: string) {
    const tmpDir = path.join(process.cwd(), 'tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);

    const tempVideo = path.join(process.cwd(), 'tmp', `${randomUUID()}.mp4`);
    writeFileSync(tempVideo, buffer);

    const timestamps = ['0', '1', '2'];

    // FFmpeg runner
    const runFFmpeg = (time: string, outputPath: string) =>
      new Promise<void>((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', [
          '-ss',
          `00:00:${time}`,
          '-i',
          tempVideo,
          '-frames:v',
          '1',
          '-an',
          '-r',
          '0.05',
          outputPath,
        ]);

        ffmpeg.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`FFmpeg exited with code ${code}`));
        });
      });

    const successfulThumbs: string[] = [];

    // Generate thumbnails sequentially
    for (const time of timestamps) {
      const thumbPath = path.join(
        process.cwd(),
        'tmp',
        `thumb_${randomUUID()}.jpg`,
      );
      try {
        await runFFmpeg(time, thumbPath);
        successfulThumbs.push(thumbPath);
      } catch (err) {
        console.warn(`Thumbnail generation failed at ${time}s:`, err);
        if (fs.existsSync(thumbPath)) unlinkSync(thumbPath); // clean partial file
      }
    }

    // Upload to S3 sequentially (or in parallel, up to you)
    const uploadedThumbs: { uri: string }[] = [];
    for (const thumbPath of successfulThumbs) {
      try {
        const key = `thumbnails/${userId}/${randomUUID()}.jpg`;
        await this.s3Client.send(
          new PutObjectCommand({
            Bucket: this.bucketName,
            Key: key,
            Body: readFileSync(thumbPath),
            ContentType: 'image/jpeg',
          }) as any,
        );
        uploadedThumbs.push({ uri: `${this.baseUrl}/${key}` });
      } catch (err) {
        console.warn(`S3 upload failed for ${thumbPath}:`, err);
      } finally {
        if (fs.existsSync(thumbPath)) unlinkSync(thumbPath); // cleanup
      }
    }

    // Cleanup video file
    if (fs.existsSync(tempVideo)) unlinkSync(tempVideo);

    return uploadedThumbs; // only successfully uploaded thumbnails
  }

  async deleteThumb(userId: string) {
    const prefix = `thumbnails/${userId}/`;
    const listed: any = await this.s3Client.send(
      new ListObjectsV2Command({
        Bucket: this.bucketName,
        Prefix: prefix,
      }) as any,
    );

    if (!listed.Contents || listed.Contents.length === 0) {
      return {
        totalDeleted: 0,
      };
    }

    const objects = listed.Contents.map((obj) => ({ Key: obj.Key }));

    const response: any = await this.s3Client.send(
      new DeleteObjectsCommand({
        Bucket: this.bucketName,
        Delete: { Objects: objects },
      }) as any,
    );
    return {
      totalDeleted: response.Deleted.length,
    };
  }
}
