import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test, type Page } from '@playwright/test';
import { finalizeVideo, startVideoRecording } from '../../src/automation/video-manager';

const execFileAsync = promisify(execFile);

test.describe('导航前的录像就绪屏障', () => {
  const options = { path: 'recording.webm', size: { width: 392, height: 852 } };
  const disposable = { dispose: async () => {}, [Symbol.asyncDispose]: async () => {} };

  test('start 返回后仍等待首帧，并使用首帧时间保留导航前画面', async () => {
    type StartOptions = NonNullable<Parameters<Page['screencast']['start']>[0]>;
    let onFrame!: NonNullable<StartOptions['onFrame']>;
    const page = { screencast: { start: async (args: StartOptions = {}) => {
      onFrame = args.onFrame!;
      return disposable;
    } } };
    let navigated = false;
    const started = startVideoRecording(page, options).then(timestamp => {
      navigated = true;
      return timestamp;
    });

    await new Promise<void>(resolveTurn => setImmediate(resolveTurn));
    expect(navigated).toBe(false);
    const firstTimestamp = Date.now() - 250;
    onFrame({ data: Buffer.alloc(0), timestamp: firstTimestamp, viewportWidth: 392, viewportHeight: 852 });
    onFrame({ data: Buffer.alloc(0), timestamp: firstTimestamp + 40, viewportWidth: 392, viewportHeight: 852 });
    await expect(started).resolves.toBe(firstTimestamp);
    expect(navigated).toBe(true);
  });

  test('没有首帧时超时失败，不进入导航', async () => {
    const page = { screencast: { start: async () => disposable } };
    let navigated = false;
    const started = startVideoRecording(page, options, 20).then(() => { navigated = true; });
    await expect(started).rejects.toThrow('未收到首帧，未打开业务页面');
    expect(navigated).toBe(false);
  });

  test('录制启动失败时直接上抛原始错误', async () => {
    const error = new Error('screencast unavailable');
    const page = { screencast: { start: async () => { throw error; } } };
    await expect(startVideoRecording(page, options)).rejects.toBe(error);
  });
});

async function temporaryVideo() {
  const directory = await mkdtemp(join(tmpdir(), 'order-video-'));
  const path = join(directory, 'recording.mp4');
  await execFileAsync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=2x2:r=30:d=0.5',
    '-an',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    path,
  ]);
  return { directory, path };
}

test.describe('失败视频配置', () => {
  test('deleteFailedVideo=false 时删除失败视频', async () => {
    const temporary = await temporaryVideo();
    try {
      const result = await finalizeVideo({
        recordedPath: temporary.path,
        success: false,
        orderId: 'order/1',
        outputDir: join(temporary.directory, 'output'),
        deleteFailedVideo: false,
      });

      expect(result).toBeUndefined();
      await expect(readFile(temporary.path)).rejects.toThrow();
    } finally {
      await rm(temporary.directory, { recursive: true, force: true });
    }
  });

  test('deleteFailedVideo=true 时重命名并移动到 failed 目录', async () => {
    const temporary = await temporaryVideo();
    try {
      const result = await finalizeVideo({
        recordedPath: temporary.path,
        success: false,
        orderId: 'order/1',
        outputDir: join(temporary.directory, 'output'),
        deleteFailedVideo: true,
      });
      expect(result).toMatch(/\/failed\/order_1-failed-\d+\.mp4$/);
      await expect(readFile(result!)).resolves.toBeTruthy();
      await expect(readFile(temporary.path)).rejects.toThrow();
    } finally {
      await rm(temporary.directory, { recursive: true, force: true });
    }
  });

  test('成功视频重命名并移动到 success 目录', async () => {
    const temporary = await temporaryVideo();
    try {
      const result = await finalizeVideo({
        recordedPath: temporary.path,
        success: true,
        orderId: 'order/1',
        outputDir: join(temporary.directory, 'output'),
        deleteFailedVideo: false,
        // 原始视频短于目标时长时仍应直接转码保存，不再触发时长校验。
        trimDurationMs: 2_000,
      });

      expect(result).toMatch(/\/success\/order_1-success-\d+\.mp4$/);
      await expect(readFile(result!)).resolves.toBeTruthy();
      await expect(readFile(temporary.path)).rejects.toThrow();
    } finally {
      await rm(temporary.directory, { recursive: true, force: true });
    }
  });
});
