import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
let videoSequence = 0;

function uniqueVideoSuffix(): string {
  videoSequence = (videoSequence + 1) % 1_000_000;
  return `${Date.now()}${process.pid}${videoSequence}`;
}

function safeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

async function transcodeVideo({
  inputPath,
  outputPath,
  trimDurationMs,
}: {
  inputPath: string;
  outputPath: string;
  trimDurationMs?: number;
}) {
  const args = ['-y', '-loglevel', 'error', '-i', inputPath];
  if (trimDurationMs !== undefined) {
    args.push('-t', `${Math.max(trimDurationMs, 100) / 1_000}`);
  }
  args.push(
    '-vf',
    'scale=392:852:flags=lanczos,setsar=1',
    '-an',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    outputPath,
  );

  try {
    await execFileAsync('ffmpeg', args);
  } catch (error) {
    await rm(outputPath, { force: true });
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`视频裁剪或转码失败：${message}`, { cause: error });
  }
}

export async function finalizeVideo({
  recordedPath,
  success,
  orderId,
  outputDir,
  deleteFailedVideo,
  trimDurationMs,
}: {
  recordedPath?: string;
  success: boolean;
  orderId: string;
  outputDir: string;
  deleteFailedVideo: boolean;
  /** 产品选择后 2–3 秒对应的原生视频时长，成功视频按此时间裁剪。 */
  trimDurationMs?: number;
}): Promise<string | undefined> {
  if (!recordedPath) return undefined;

  if (!success) {
    // 按当前调试配置约定：true 保留失败视频并标记 failed，false 直接删除。
    if (!deleteFailedVideo) {
      await rm(recordedPath, { force: true });
      return undefined;
    }

    const failedDir = `${outputDir}/failed`;
    await mkdir(failedDir, { recursive: true });
    const failedPath = `${failedDir}/${safeFilename(orderId)}-failed-${uniqueVideoSuffix()}.mp4`;
    await transcodeVideo({ inputPath: recordedPath, outputPath: failedPath });
    await rm(recordedPath, { force: true });
    return failedPath;
  }

  const successDir = `${outputDir}/success`;
  await mkdir(successDir, { recursive: true });
  const successPath = `${successDir}/${safeFilename(orderId)}-success-${uniqueVideoSuffix()}.mp4`;
  await transcodeVideo({
    inputPath: recordedPath,
    outputPath: successPath,
    trimDurationMs,
  });
  await rm(recordedPath, { force: true });
  return successPath;
}
