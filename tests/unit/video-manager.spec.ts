import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { finalizeVideo } from '../../src/automation/video-manager';

const execFileAsync = promisify(execFile);

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
        trimDurationMs: 300,
      });

      expect(result).toMatch(/\/success\/order_1-success-\d+\.mp4$/);
      await expect(readFile(result!)).resolves.toBeTruthy();
      await expect(readFile(temporary.path)).rejects.toThrow();
    } finally {
      await rm(temporary.directory, { recursive: true, force: true });
    }
  });
});
