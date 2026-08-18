import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Video } from '@playwright/test';
import { finalizeVideo } from '../../src/automation/video-manager';

async function temporaryVideo() {
  const directory = await mkdtemp(join(tmpdir(), 'order-video-'));
  const path = join(directory, 'recording.webm');
  await writeFile(path, 'temporary video');
  const video = { path: async () => path } as Video;
  return { directory, path, video };
}

test.describe('失败视频配置', () => {
  test('配置删除时移除失败视频', async () => {
    const temporary = await temporaryVideo();
    try {
      const result = await finalizeVideo({
        video: temporary.video,
        success: false,
        orderId: 'order/1',
        outputDir: join(temporary.directory, 'output'),
        deleteFailedVideo: true,
      });

      expect(result).toBeUndefined();
      await expect(readFile(temporary.path)).rejects.toThrow();
    } finally {
      await rm(temporary.directory, { recursive: true, force: true });
    }
  });

  test('配置保留时移动到 failed 目录并清理文件名', async () => {
    const temporary = await temporaryVideo();
    try {
      const result = await finalizeVideo({
        video: temporary.video,
        success: false,
        orderId: 'order/1',
        outputDir: join(temporary.directory, 'output'),
        deleteFailedVideo: false,
      });

      expect(result).toContain('/failed/order_1-');
      await expect(readFile(result!)).resolves.toBeTruthy();
      await expect(readFile(temporary.path)).rejects.toThrow();
    } finally {
      await rm(temporary.directory, { recursive: true, force: true });
    }
  });
});
