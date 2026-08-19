import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { once } from 'node:events';
import type { Page } from '@playwright/test';

// 20fps 提高短暂点击反馈的可见概率，同时控制截图和编码开销。
const FRAME_RATE = 20;
const FRAME_INTERVAL_MS = 1_000 / FRAME_RATE;
const VIDEO_SIZE = { width: 393, height: 852 } as const;

const sleep = (durationMs: number) => new Promise((resolve) => setTimeout(resolve, durationMs));

export interface ScreenRecorder {
  stop(): Promise<string>;
}

/**
 * 使用页面截图和 ffmpeg 独立录制屏幕帧。
 *
 * Playwright 原生 Video 只能在页面/上下文关闭后完成，无法满足“停止录像但继续监控页面”。
 * 这个录像器只停止截图和编码进程，不会影响浏览器页面生命周期。
 */
export async function startScreenRecorder({
  page,
  outputPath,
}: {
  page: Page;
  outputPath: string;
}): Promise<ScreenRecorder> {
  await mkdir(dirname(outputPath), { recursive: true });

  const ffmpeg = spawn(
    'ffmpeg',
    [
      '-y',
      '-f',
      'image2pipe',
      '-framerate',
      String(FRAME_RATE),
      '-vcodec',
      'png',
      '-i',
      'pipe:0',
      '-vf',
      `scale=${VIDEO_SIZE.width}:${VIDEO_SIZE.height}:flags=lanczos,crop=${VIDEO_SIZE.width}:${VIDEO_SIZE.height - 2}:0:0,scale=${VIDEO_SIZE.width}:${VIDEO_SIZE.height}:flags=lanczos,format=yuv444p,setsar=1`,
      '-an',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv444p',
      '-movflags',
      '+faststart',
      outputPath,
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] },
  );

  let ffmpegError = '';
  ffmpeg.stderr.on('data', (chunk: Buffer) => {
    ffmpegError = `${ffmpegError}${chunk.toString()}`.slice(-2_000);
  });

  const processDone = new Promise<number>((resolve, reject) => {
    ffmpeg.once('error', reject);
    ffmpeg.once('close', (code) => resolve(code ?? 1));
  });

  let stopped = false;
  let captureError: unknown;
  const captureLoop = (async () => {
    while (!stopped) {
      const startedAt = Date.now();
      try {
        // 必须允许 CSS transition/animation，否则自定义键盘的点击反馈会被截图关闭。
        const frame = await page.screenshot({ animations: 'allow' });
        if (!ffmpeg.stdin.write(frame)) await once(ffmpeg.stdin, 'drain');
      } catch (error) {
        if (!stopped) captureError = error;
        break;
      }

      await sleep(Math.max(0, FRAME_INTERVAL_MS - (Date.now() - startedAt)));
    }
  })();

  let stopPromise: Promise<string> | undefined;
  return {
    stop: () => {
      if (stopPromise) return stopPromise;

      stopPromise = (async () => {
        stopped = true;
        await captureLoop;
        if (captureError) throw captureError;

        ffmpeg.stdin.end();
        const code = await processDone;
        if (code !== 0) {
          throw new Error(`视频编码失败（ffmpeg ${code}）：${ffmpegError}`);
        }
        return outputPath;
      })();

      return stopPromise;
    },
  };
}
