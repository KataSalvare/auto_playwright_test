import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { finalizeVideo } from '../../src/automation/video-manager';

async function temporaryVideo() {
  const directory = await mkdtemp(join(tmpdir(), 'order-video-'));
  const path = join(directory, 'recording.mp4');
  await writeFile(path, 'temporary video');
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
      });

      expect(result).toMatch(/\/success\/order_1-success-\d+\.mp4$/);
      await expect(readFile(result!)).resolves.toBeTruthy();
      await expect(readFile(temporary.path)).rejects.toThrow();
    } finally {
      await rm(temporary.directory, { recursive: true, force: true });
    }
  });
});
