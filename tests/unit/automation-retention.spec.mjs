import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test } from '@playwright/test';
import { cleanupAutomationData } from '../../scripts/automation-retention.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

async function createOutputFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'automation-retention-'));
  const outputDir = join(directory, 'output');
  await mkdir(outputDir, { recursive: true });
  return { directory, outputDir };
}

async function writeJson(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2));
}

async function makeOld(filePath, now, days) {
  const timestamp = new Date(now - (days * DAY_MS) - 1_000);
  await utimes(filePath, timestamp, timestamp);
}

test('只清理已完成且超过保留期的 API 视频和任务记录', async () => {
  const { directory, outputDir } = await createOutputFixture();
  const now = Date.now();
  const videoPath = join(outputDir, 'videos', 'success', 'old.mp4');
  const jobPath = join(outputDir, 'automation-jobs', 'job-old', 'job.json');
  try {
    await mkdir(join(outputDir, 'videos', 'success'), { recursive: true });
    await writeFile(videoPath, 'video');
    await writeJson(jobPath, {
      jobId: 'job-old',
      status: 'completed',
      completedAt: now - (31 * DAY_MS),
      results: [{
        status: 'success',
        success: true,
        callbackStatus: 'success',
        completedAt: now - (31 * DAY_MS),
        videoPath,
      }],
    });
    await makeOld(videoPath, now, 31);
    await makeOld(jobPath, now, 31);

    const summary = await cleanupAutomationData({ outputDir, now });
    await expect(stat(videoPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(outputDir, 'automation-jobs', 'job-old'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(summary.deleted.apiVideos).toBe(1);
    expect(summary.deleted.apiJobs).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('待发送回调的任务和视频不会被清理', async () => {
  const { directory, outputDir } = await createOutputFixture();
  const now = Date.now();
  const videoPath = join(outputDir, 'videos', 'success', 'pending.mp4');
  const jobPath = join(outputDir, 'automation-jobs', 'job-pending', 'job.json');
  try {
    await mkdir(join(outputDir, 'videos', 'success'), { recursive: true });
    await writeFile(videoPath, 'video');
    await writeJson(jobPath, {
      jobId: 'job-pending',
      status: 'completed',
      completedAt: now - (31 * DAY_MS),
      results: [{ status: 'success', success: true, callbackStatus: 'pending', videoPath }],
    });
    await makeOld(videoPath, now, 31);
    await makeOld(jobPath, now, 31);

    const summary = await cleanupAutomationData({ outputDir, now });
    await expect(stat(videoPath)).resolves.toBeTruthy();
    await expect(stat(jobPath)).resolves.toBeTruthy();
    expect(summary.deleted.apiVideos).toBe(0);
    expect(summary.deleted.apiJobs).toBe(0);
    expect(summary.skipped.pendingCallbacks).toBeGreaterThan(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('dry-run 只报告待清理内容，不删除文件', async () => {
  const { directory, outputDir } = await createOutputFixture();
  const now = Date.now();
  const videoPath = join(outputDir, 'videos', 'failed', 'old.mp4');
  try {
    await mkdir(join(outputDir, 'videos', 'failed'), { recursive: true });
    await writeFile(videoPath, 'video');
    await makeOld(videoPath, now, 2);

    const summary = await cleanupAutomationData({ outputDir, now, dryRun: true });
    await expect(stat(videoPath)).resolves.toBeTruthy();
    expect(summary.dryRun).toBe(true);
    expect(summary.deleted.apiVideos).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('前端快速测试视频和任务记录按独立保留期清理', async () => {
  const { directory, outputDir } = await createOutputFixture();
  const now = Date.now();
  const videoPath = join(outputDir, 'quick-test-videos', 'success', 'old.mp4');
  const runPath = join(outputDir, 'quick-test-runs', 'run-old', 'run.json');
  try {
    await mkdir(join(outputDir, 'quick-test-videos', 'success'), { recursive: true });
    await writeFile(videoPath, 'video');
    await writeJson(runPath, {
      runId: 'run-old',
      status: 'completed',
      completedAt: now - (4 * DAY_MS),
      results: [{ status: 'success', videoPath }],
    });
    await makeOld(videoPath, now, 4);
    await makeOld(runPath, now, 4);

    const summary = await cleanupAutomationData({ outputDir, now });
    await expect(stat(videoPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(outputDir, 'quick-test-runs', 'run-old'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(summary.deleted.quickTestVideos).toBe(1);
    expect(summary.deleted.quickTestRuns).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
