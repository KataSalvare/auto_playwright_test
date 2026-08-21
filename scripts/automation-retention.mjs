#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';

export const DEFAULT_RETENTION_POLICY = Object.freeze({
  successVideoDays: 7,
  failedVideoDays: 1,
  callbackFailedVideoDays: 30,
  jobRecordDays: 30,
  quickTestDays: 3,
  logDays: 14,
  maxLogBytes: 50 * 1024 * 1024,
});

const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm']);
const LOG_NAMES = Object.freeze(['quick-test-server.log', 'automation-api.log']);

function isMissing(error) { return error?.code === 'ENOENT'; }
function logMessage(logger, level, message) { logger?.(level, message); }
function numericOption(value, fallback, minimum = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}
function normalizePolicy(options = {}) {
  return {
    successVideoDays: numericOption(options.successVideoDays, DEFAULT_RETENTION_POLICY.successVideoDays),
    failedVideoDays: numericOption(options.failedVideoDays, DEFAULT_RETENTION_POLICY.failedVideoDays),
    callbackFailedVideoDays: numericOption(options.callbackFailedVideoDays, DEFAULT_RETENTION_POLICY.callbackFailedVideoDays),
    jobRecordDays: numericOption(options.jobRecordDays, DEFAULT_RETENTION_POLICY.jobRecordDays),
    quickTestDays: numericOption(options.quickTestDays, DEFAULT_RETENTION_POLICY.quickTestDays),
    logDays: numericOption(options.logDays, DEFAULT_RETENTION_POLICY.logDays),
    maxLogBytes: numericOption(options.maxLogBytes, DEFAULT_RETENTION_POLICY.maxLogBytes, 1),
  };
}

async function directoryEntries(directory) {
  try { return await readdir(directory, { withFileTypes: true }); } catch (error) { if (isMissing(error)) return []; throw error; }
}

async function listFiles(directory) {
  const files = [];
  for (const entry of await directoryEntries(directory)) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

async function readJson(filePath) {
  try { return JSON.parse(await readFile(filePath, 'utf8')); } catch (error) {
    if (isMissing(error)) return null;
    return null;
  }
}

function isWithin(root, target) {
  const relativePath = relative(resolve(root), resolve(target));
  return Boolean(relativePath) && !relativePath.startsWith('..') && !isAbsolute(relativePath);
}

function resolveStoredPath(value, outputDir) {
  if (!value || typeof value !== 'string') return '';
  if (isAbsolute(value)) return resolve(value);
  const normalized = value.replaceAll('\\', '/');
  return normalized.startsWith('output/')
    ? resolve(outputDir, '..', normalized)
    : resolve(outputDir, normalized);
}

function ageReferenceMs(fileStats, completedAt) {
  const timestamps = [fileStats.mtimeMs, Number(completedAt)].filter((value) => Number.isFinite(value) && value > 0);
  return timestamps.length > 0 ? Math.max(...timestamps) : fileStats.mtimeMs;
}

function olderThan(fileStats, completedAt, now, days) {
  return ageReferenceMs(fileStats, completedAt) <= now - (days * 24 * 60 * 60 * 1000);
}

function resultIsFailed(result) { return result?.status === 'failed' || result?.success === false; }
function resultIsPendingCallback(result) { return result?.callbackStatus === 'pending' || result?.callbackStatus === 'sending'; }

function emptySummary(dryRun, policy) {
  return {
    dryRun,
    policy,
    deleted: { apiVideos: 0, apiJobs: 0, quickTestVideos: 0, quickTestRuns: 0, rotatedLogs: 0, oldLogs: 0 },
    bytesFreed: 0,
    skipped: { activeJobs: 0, pendingCallbacks: 0, invalidRecords: 0 },
  };
}

async function removeFile(filePath, summary, field, dryRun, logger) {
  let fileStats;
  try { fileStats = await stat(filePath); } catch (error) { if (isMissing(error)) return; throw error; }
  if (dryRun) {
    logMessage(logger, 'INFO', `[dry-run] 准备删除 ${filePath}`);
    return;
  }
  await rm(filePath, { force: true });
  summary.deleted[field] += 1;
  summary.bytesFreed += fileStats.size;
  logMessage(logger, 'INFO', `已删除 ${filePath}`);
}

async function removeDirectory(directory, summary, field, dryRun, logger) {
  let fileStats = [];
  try { fileStats = await Promise.all((await listFiles(directory)).map(async (filePath) => stat(filePath))); } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (dryRun) {
    logMessage(logger, 'INFO', `[dry-run] 准备删除目录 ${directory}`);
    return;
  }
  await rm(directory, { recursive: true, force: true });
  summary.deleted[field] += 1;
  summary.bytesFreed += fileStats.reduce((total, item) => total + item.size, 0);
  logMessage(logger, 'INFO', `已删除目录 ${directory}`);
}

async function loadJobRecords(automationJobRoot, outputDir, summary) {
  const jobs = [];
  const videoMetadata = new Map();
  for (const entry of await directoryEntries(automationJobRoot)) {
    if (!entry.isDirectory()) continue;
    const directory = join(automationJobRoot, entry.name);
    const job = await readJson(join(directory, 'job.json'));
    if (!job?.jobId || !Array.isArray(job.results)) {
      summary.skipped.invalidRecords += 1;
      continue;
    }
    jobs.push({ directory, job });
    for (const result of job.results) {
      const videoPath = resolveStoredPath(result.videoPath, outputDir);
      if (!videoPath || !isWithin(resolve(outputDir, 'videos'), videoPath)) continue;
      const key = resolve(videoPath);
      const metadata = videoMetadata.get(key) || [];
      metadata.push({
        job,
        result,
        completedAt: result.completedAt || job.completedAt,
        active: job.status !== 'completed',
        pendingCallback: resultIsPendingCallback(result),
        callbackFailed: result.callbackStatus === 'failed',
        failed: resultIsFailed(result),
      });
      videoMetadata.set(key, metadata);
    }
  }
  return { jobs, videoMetadata };
}

async function loadQuickTestRecords(quickTestRunRoot, outputDir, summary) {
  const runs = [];
  const videoMetadata = new Map();
  for (const entry of await directoryEntries(quickTestRunRoot)) {
    if (!entry.isDirectory()) continue;
    const directory = join(quickTestRunRoot, entry.name);
    const run = await readJson(join(directory, 'run.json'));
    if (!run?.runId || !Array.isArray(run.results)) {
      summary.skipped.invalidRecords += 1;
      continue;
    }
    runs.push({ directory, run });
    for (const result of run.results) {
      const videoPath = resolveStoredPath(result.videoPath, outputDir);
      if (!videoPath || !isWithin(resolve(outputDir, 'quick-test-videos'), videoPath)) continue;
      const key = resolve(videoPath);
      const metadata = videoMetadata.get(key) || [];
      metadata.push({ run, completedAt: run.completedAt, active: run.status !== 'completed' });
      videoMetadata.set(key, metadata);
    }
  }
  return { runs, videoMetadata };
}

async function cleanApiVideos(videoRoot, metadataByPath, now, policy, summary, dryRun, logger) {
  for (const filePath of await listFiles(videoRoot)) {
    if (!VIDEO_EXTENSIONS.has(extname(filePath).toLowerCase())) continue;
    const fileStats = await stat(filePath);
    const metadata = metadataByPath.get(resolve(filePath)) || [];
    if (metadata.some((item) => item.active)) {
      summary.skipped.activeJobs += 1;
      continue;
    }
    if (metadata.some((item) => item.pendingCallback)) {
      summary.skipped.pendingCallbacks += 1;
      continue;
    }
    const callbackFailed = metadata.some((item) => item.callbackFailed);
    const failed = metadata.some((item) => item.failed) || isWithin(resolve(videoRoot, 'failed'), filePath);
    const days = callbackFailed
      ? policy.callbackFailedVideoDays
      : failed ? policy.failedVideoDays : policy.successVideoDays;
    const completedAt = metadata.reduce((latest, item) => Math.max(latest, Number(item.completedAt) || 0), 0);
    if (olderThan(fileStats, completedAt, now, days)) await removeFile(filePath, summary, 'apiVideos', dryRun, logger);
  }
}

async function cleanApiJobs(jobs, now, policy, summary, dryRun, logger) {
  for (const { directory, job } of jobs) {
    if (job.status !== 'completed') {
      summary.skipped.activeJobs += 1;
      continue;
    }
    if (job.results.some(resultIsPendingCallback)) {
      summary.skipped.pendingCallbacks += 1;
      continue;
    }
    if (olderThan(await stat(join(directory, 'job.json')), job.completedAt, now, policy.jobRecordDays)) {
      await removeDirectory(directory, summary, 'apiJobs', dryRun, logger);
    }
  }
}

async function cleanQuickTestVideos(videoRoot, metadataByPath, now, policy, summary, dryRun, logger) {
  for (const filePath of await listFiles(videoRoot)) {
    if (!VIDEO_EXTENSIONS.has(extname(filePath).toLowerCase())) continue;
    const fileStats = await stat(filePath);
    const metadata = metadataByPath.get(resolve(filePath)) || [];
    if (metadata.some((item) => item.active)) {
      summary.skipped.activeJobs += 1;
      continue;
    }
    const completedAt = metadata.reduce((latest, item) => Math.max(latest, Number(item.completedAt) || 0), 0);
    if (olderThan(fileStats, completedAt, now, policy.quickTestDays)) {
      await removeFile(filePath, summary, 'quickTestVideos', dryRun, logger);
    }
  }
}

async function cleanQuickTestRuns(runs, now, policy, summary, dryRun, logger) {
  for (const { directory, run } of runs) {
    if (run.status !== 'completed') {
      summary.skipped.activeJobs += 1;
      continue;
    }
    const files = await listFiles(directory);
    const stats = await Promise.all(files.map((filePath) => stat(filePath)));
    const latestMtime = stats.reduce((latest, item) => Math.max(latest, item.mtimeMs), 0);
    if (latestMtime > now - (policy.quickTestDays * 24 * 60 * 60 * 1000)) continue;
    if (olderThan(await stat(join(directory, 'run.json')), run.completedAt, now, policy.quickTestDays)) {
      await removeDirectory(directory, summary, 'quickTestRuns', dryRun, logger);
    }
  }
}

async function cleanLogs(outputDir, now, policy, summary, dryRun, logger) {
  const cutoff = now - (policy.logDays * 24 * 60 * 60 * 1000);
  for (const logName of LOG_NAMES) {
    const logPath = join(outputDir, logName);
    try {
      const logStats = await stat(logPath);
      if (logStats.size > policy.maxLogBytes) {
        const archivePath = `${logPath}.${new Date(now).toISOString().replaceAll(':', '-')}`;
        if (dryRun) logMessage(logger, 'INFO', `[dry-run] 准备轮转日志 ${logPath}`);
        else {
          await rename(logPath, archivePath);
          await writeFile(logPath, '');
          summary.deleted.rotatedLogs += 1;
          logMessage(logger, 'INFO', `已轮转日志 ${logPath} -> ${archivePath}`);
        }
      }
    } catch (error) { if (!isMissing(error)) throw error; }
  }
  for (const entry of await directoryEntries(outputDir)) {
    if (!entry.isFile() || !entry.name.includes('.log.')) continue;
    const filePath = join(outputDir, entry.name);
    const fileStats = await stat(filePath);
    if (fileStats.mtimeMs <= cutoff) await removeFile(filePath, summary, 'oldLogs', dryRun, logger);
  }
}

export async function cleanupAutomationData({
  outputDir = resolve(process.cwd(), 'output'),
  now = Date.now(),
  dryRun = false,
  logger = () => {},
  ...options
} = {}) {
  const resolvedOutputDir = resolve(outputDir);
  const policy = normalizePolicy(options);
  const summary = emptySummary(dryRun, policy);
  const videoRoot = resolve(resolvedOutputDir, 'videos');
  const quickTestVideoRoot = resolve(resolvedOutputDir, 'quick-test-videos');
  const { jobs, videoMetadata } = await loadJobRecords(resolve(resolvedOutputDir, 'automation-jobs'), resolvedOutputDir, summary);
  const { runs, videoMetadata: quickTestMetadata } = await loadQuickTestRecords(resolve(resolvedOutputDir, 'quick-test-runs'), resolvedOutputDir, summary);

  await cleanApiVideos(videoRoot, videoMetadata, now, policy, summary, dryRun, logger);
  await cleanApiJobs(jobs, now, policy, summary, dryRun, logger);
  await cleanQuickTestVideos(quickTestVideoRoot, quickTestMetadata, now, policy, summary, dryRun, logger);
  await cleanQuickTestRuns(runs, now, policy, summary, dryRun, logger);
  await cleanLogs(resolvedOutputDir, now, policy, summary, dryRun, logger);
  return summary;
}

function optionValue(args, name, fallback) {
  const index = args.findIndex((argument) => argument === name || argument.startsWith(`${name}=`));
  if (index < 0) return fallback;
  const argument = args[index];
  return argument.includes('=') ? argument.slice(name.length + 1) : args[index + 1];
}

function cliOptions(args) {
  return {
    outputDir: optionValue(args, '--output-dir', resolve(process.cwd(), 'output')),
    dryRun: args.includes('--dry-run'),
    successVideoDays: optionValue(args, '--success-video-days', undefined),
    failedVideoDays: optionValue(args, '--failed-video-days', undefined),
    callbackFailedVideoDays: optionValue(args, '--callback-failed-video-days', undefined),
    jobRecordDays: optionValue(args, '--job-record-days', undefined),
    quickTestDays: optionValue(args, '--quick-test-days', undefined),
    logDays: optionValue(args, '--log-days', undefined),
    maxLogBytes: optionValue(args, '--max-log-bytes', undefined),
  };
}

async function main() {
  const summary = await cleanupAutomationData({ ...cliOptions(process.argv.slice(2)), logger: (level, message) => console.log(`[${level}] ${message}`) });
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
