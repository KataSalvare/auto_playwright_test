import { mkdir, rename, rm } from 'node:fs/promises';

function safeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export async function finalizeVideo({
  recordedPath,
  success,
  orderId,
  outputDir,
  deleteFailedVideo,
}: {
  recordedPath?: string;
  success: boolean;
  orderId: string;
  outputDir: string;
  deleteFailedVideo: boolean;
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
    const failedPath = `${failedDir}/${safeFilename(orderId)}-failed-${Date.now()}.mp4`;
    await rename(recordedPath, failedPath);
    return failedPath;
  }

  const successDir = `${outputDir}/success`;
  await mkdir(successDir, { recursive: true });
  const successPath = `${successDir}/${safeFilename(orderId)}-success-${Date.now()}.mp4`;
  await rename(recordedPath, successPath);
  return successPath;
}
