import { execFile } from 'node:child_process';
import { mkdir, rename, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { Video } from '@playwright/test';

const execFileAsync = promisify(execFile);

function safeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export async function finalizeVideo({
  video,
  success,
  orderId,
  outputDir,
  deleteFailedVideo,
}: {
  video: Video | null;
  success: boolean;
  orderId: string;
  outputDir: string;
  deleteFailedVideo: boolean;
}): Promise<string | undefined> {
  if (!video) return undefined;

  const recordedPath = await video.path();
  if (!success) {
    if (deleteFailedVideo) {
      await rm(recordedPath, { force: true });
      return undefined;
    }

    const failedDir = `${outputDir}/failed`;
    await mkdir(failedDir, { recursive: true });
    const failedPath = `${failedDir}/${safeFilename(orderId)}-${Date.now()}.webm`;
    await rename(recordedPath, failedPath);
    return failedPath;
  }

  await mkdir(outputDir, { recursive: true });
  const outputPath = `${outputDir}/${safeFilename(orderId)}.mp4`;

  try {
    await execFileAsync('ffmpeg', [
      '-y',
      '-i',
      recordedPath,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-movflags',
      '+faststart',
      outputPath,
    ]);
  } catch (error) {
    throw new Error(
      `成功视频无法转换为 MP4，请安装 ffmpeg。临时视频保留在：${recordedPath}`,
      { cause: error },
    );
  }

  await rm(recordedPath, { force: true });
  return outputPath;
}
