import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { finalizeVideo } from '../../src/automation/video-manager';

const execFileAsync = promisify(execFile);

async function temporaryVideo(durationSeconds = 0.5) {
  const directory = await mkdtemp(join(tmpdir(), 'order-video-'));
  const path = join(directory, 'recording.mp4');
  await execFileAsync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `color=c=black:s=2x2:r=30:d=${durationSeconds}`,
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
      const probe = await execFileAsync('ffprobe', [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        result!,
      ]);
      const durationMs = Number.parseFloat(probe.stdout.trim()) * 1_000;
      expect(durationMs).toBeGreaterThanOrEqual(200);
      expect(durationMs).toBeLessThanOrEqual(500);
      await expect(readFile(temporary.path)).rejects.toThrow();
    } finally {
      await rm(temporary.directory, { recursive: true, force: true });
    }
  });
});

test('原始视频明显短于目标裁切时长时报告录制异常', async () => {
  const temporary = await temporaryVideo(1);
  try {
    await expect(finalizeVideo({
      recordedPath: temporary.path,
      success: true,
      orderId: 'short-order',
      outputDir: join(temporary.directory, 'output'),
      deleteFailedVideo: false,
      trimDurationMs: 3_000,
    })).rejects.toThrow(/视频录制异常：原始视频时长 .*目标时长 .*短缺 .*失败视频：/);

    await expect(readFile(temporary.path)).rejects.toThrow();
    const failedFiles = await readdir(join(temporary.directory, 'output', 'failed'));
    expect(failedFiles).toHaveLength(1);
    expect(failedFiles[0]).toMatch(/short-order-recording-anomaly-\d+\.mp4$/);
    await expect(readdir(join(temporary.directory, 'output', 'success'))).rejects.toThrow();
  } finally {
    await rm(temporary.directory, { recursive: true, force: true });
  }
});
