#!/usr/bin/env node

/**
 * 跨平台快速测试页面服务管理器。
 *
 * 用法：
 *   node scripts/quick-test-server.mjs start
 *   node scripts/quick-test-server.mjs restart
 *   node scripts/quick-test-server.mjs stop
 *   node scripts/quick-test-server.mjs status
 *
 * 只使用 Node.js 内置模块，不依赖 Python 或额外前端服务。
 */
import { createServer, request as httpRequest } from 'node:http';
import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync, openSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { basename, extname, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';

const SCRIPT_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PROJECT_DIR = resolve(SCRIPT_DIR, '..');
const WEB_ROOT = resolve(PROJECT_DIR, 'web');
const OUTPUT_DIR = resolve(PROJECT_DIR, 'output');
const LEGACY_VIDEO_ROOT = resolve(OUTPUT_DIR, 'videos');
const QUICK_TEST_VIDEO_ROOT = resolve(OUTPUT_DIR, 'quick-test-videos');
const QUICK_RUN_ROOT = resolve(OUTPUT_DIR, 'quick-test-runs');
const AUTOMATION_JOB_ROOT = resolve(OUTPUT_DIR, 'automation-jobs');
const RUNNER_SCRIPT = resolve(PROJECT_DIR, 'scripts', 'quick-test-runner.ts');
const LEGACY_STATE_FILE = resolve(OUTPUT_DIR, 'quick-test-server.json');
const LOG_FILE = resolve(OUTPUT_DIR, 'quick-test-server.log');
const DEFAULT_PORT = 4173;
// 默认监听所有 IPv4 网卡，同时支持本机和同一局域网设备访问。
const DEFAULT_HOST = '0.0.0.0';
const MAX_CONCURRENT_AUTOMATIONS = Math.min(10, Math.max(1, Number.parseInt(process.env.QUICK_TEST_MAX_CONCURRENCY || '4', 10) || 4));
const MAX_ERROR_OUTPUT_LENGTH = 64 * 1024;
const QUICK_TEST_RUNS = new Map();
const AUTOMATION_JOBS = new Map();
const AUTOMATION_QUEUE = [];
const ACTIVE_CHILDREN = new Set();
let activeAutomations = 0;

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

const AUTOMATION_API_KEY = process.env.AUTOMATION_API_KEY || '';
const MAX_AUTOMATION_LINKS = 50;
const MAX_AUTOMATION_CONCURRENCY = 10;

function automationJobDirectoryFor(jobId) { return resolve(AUTOMATION_JOB_ROOT, jobId); }
function automationJobStateFileFor(jobId) { return resolve(automationJobDirectoryFor(jobId), 'job.json'); }
function persistAutomationJob(job) {
  mkdirSync(automationJobDirectoryFor(job.jobId), { recursive: true });
  writeFileSync(automationJobStateFileFor(job.jobId), JSON.stringify(job, null, 2));
}
function loadPersistedAutomationJobs() {
  if (!existsSync(AUTOMATION_JOB_ROOT)) return;
  for (const entry of readdirSync(AUTOMATION_JOB_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const job = JSON.parse(readFileSync(automationJobStateFileFor(entry.name), 'utf8'));
      if (!job?.jobId || !Array.isArray(job.results)) continue;
      if (job.status !== 'completed') {
        job.results = job.results.map((result) => result.status === 'queued' || result.status === 'running'
          ? { ...result, status: 'failed', success: false, error: '自动化 API 服务停止，任务未完成' }
          : result);
        job.status = 'completed';
        job.completedAt = Date.now();
        persistAutomationJob(job);
      }
      AUTOMATION_JOBS.set(job.jobId, job);
    } catch { /* 忽略未完成写入或旧格式的任务记录 */ }
  }
}

function parseOptions(args) {
  const options = { port: DEFAULT_PORT, host: DEFAULT_HOST };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--port') options.port = Number(args[++index]);
    else if (argument.startsWith('--port=')) options.port = Number(argument.slice('--port='.length));
    else if (argument === '--host') options.host = args[++index];
    else if (argument.startsWith('--host=')) options.host = argument.slice('--host='.length);
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('端口必须是 1–65535 之间的整数');
  return options;
}

function ensureOutputDir() { mkdirSync(OUTPUT_DIR, { recursive: true }); }
function formatLogMessage(level, message) { return `[${new Date().toISOString()}] [${level}] ${message}`; }
function appendServerLog(level, message) {
  try {
    ensureOutputDir();
    appendFileSync(LOG_FILE, `${formatLogMessage(level, message)}\n`, 'utf8');
  } catch (error) {
    process.stderr.write(`[日志写入失败] ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
function commandLog(level, message) {
  const line = formatLogMessage(level, message);
  appendServerLog(level, message);
  if (level === 'ERROR') console.error(line);
  else console.log(line);
}
function runDirectoryFor(runId) { return resolve(QUICK_RUN_ROOT, runId); }
function runStateFileFor(runId) { return resolve(runDirectoryFor(runId), 'run.json'); }
function persistRun(run) {
  mkdirSync(runDirectoryFor(run.runId), { recursive: true });
  writeFileSync(runStateFileFor(run.runId), JSON.stringify(run, null, 2));
}
function loadPersistedRuns() {
  if (!existsSync(QUICK_RUN_ROOT)) return;
  for (const entry of readdirSync(QUICK_RUN_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const run = JSON.parse(readFileSync(runStateFileFor(entry.name), 'utf8'));
      if (!run?.runId || !Array.isArray(run.results)) continue;
      if (run.status !== 'completed') {
        run.results = run.results.map((result) => result.status === 'queued' || result.status === 'running'
          ? { ...result, status: 'failed', successful: false, error: '快速测试服务停止，任务未完成' }
          : result);
        run.status = 'completed';
        run.completedAt = Date.now();
        persistRun(run);
      }
      QUICK_TEST_RUNS.set(run.runId, run);
    } catch { /* 忽略未完成写入或旧格式的运行记录 */ }
  }
}
function stateFileForPort(port) { return resolve(OUTPUT_DIR, `quick-test-server-${port}.json`); }
function readState(port) {
  const files = [stateFileForPort(port)];
  if (port === DEFAULT_PORT) files.push(LEGACY_STATE_FILE);
  for (const file of files) {
    try {
      const state = JSON.parse(readFileSync(file, 'utf8'));
      if (state.port === port) return state;
    } catch { /* state file does not exist or is incomplete */ }
  }
  return null;
}
function removeState(port) {
  for (const file of [stateFileForPort(port), ...(port === DEFAULT_PORT ? [LEGACY_STATE_FILE] : [])]) {
    if (existsSync(file)) unlinkSync(file);
  }
}
function isRunning(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } }
function writeState(state) { ensureOutputDir(); writeFileSync(stateFileForPort(state.port), JSON.stringify(state, null, 2)); }
function getLanIPv4Addresses() {
  const addresses = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      const isIPv4 = entry.family === 'IPv4' || entry.family === 4;
      if (isIPv4 && !entry.internal) addresses.push(entry.address);
    }
  }
  return [...new Set(addresses)];
}

function displayAccessUrls(host, port) {
  if (host !== '0.0.0.0' && host !== '::') return `http://${host}:${port}/web/`;

  const localUrl = `http://127.0.0.1:${port}/web/`;
  const lanUrls = getLanIPv4Addresses().map((address) => `http://${address}:${port}/web/`);
  if (lanUrls.length === 0) return `本机：${localUrl}；未检测到局域网 IPv4 地址`;
  return `本机：${localUrl}；局域网：${lanUrls.join('、')}`;
}

function probeQuickTestServer(options) {
  const hostname = options.host === '0.0.0.0' ? '127.0.0.1' : options.host;
  return new Promise((resolvePromise) => {
    const request = httpRequest({ hostname, port: options.port, path: '/api/quick-test/health', method: 'GET', timeout: 500 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try { resolvePromise(response.statusCode === 200 ? JSON.parse(body) : null); } catch { resolvePromise(null); }
      });
    });
    request.on('error', () => resolvePromise(null));
    request.on('timeout', () => request.destroy());
    request.end();
  });
}

async function stopOrphanedQuickTestServer(options) {
  const discovered = await probeQuickTestServer(options);
  if (discovered?.service !== 'quick-test-server' || !isRunning(discovered.pid)) return false;
  try { process.kill(discovered.pid); } catch { return false; }
  const deadline = Date.now() + 3000;
  while (isRunning(discovered.pid) && Date.now() < deadline) await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  return !isRunning(discovered.pid);
}

function safeWebPath(requestPath) {
  let pathname;
  try { pathname = decodeURIComponent(requestPath.split('?')[0]); } catch { return null; }
  if (pathname === '/' || pathname === '/web' || pathname === '/web/') pathname = '/index.html';
  else if (pathname.startsWith('/web/')) pathname = pathname.slice('/web'.length);
  else return null;
  const filePath = resolve(WEB_ROOT, `.${normalize(pathname)}`);
  const relativePath = relative(WEB_ROOT, filePath);
  if (!relativePath || relativePath.startsWith('..')) return null;
  return filePath;
}

function safeVideoPath(requestPath) {
  let pathname;
  try { pathname = decodeURIComponent(requestPath.split('?')[0]); } catch { return null; }
  const isQuickTestVideo = pathname.startsWith('/quick-test-videos/');
  const videoRoot = isQuickTestVideo ? QUICK_TEST_VIDEO_ROOT : pathname.startsWith('/videos/') ? LEGACY_VIDEO_ROOT : null;
  if (!videoRoot) return null;
  const prefixLength = isQuickTestVideo ? '/quick-test-videos'.length : '/videos'.length;
  const filePath = resolve(videoRoot, `.${normalize(pathname.slice(prefixLength))}`);
  const relativePath = relative(videoRoot, filePath);
  if (!relativePath || relativePath.startsWith('..')) return null;
  return filePath;
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(payload));
}

function isAuthorizedAutomationRequest(request) {
  if (!AUTOMATION_API_KEY) return false;
  const authorization = request.headers.authorization || '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : '';
  const headerKey = typeof request.headers['x-api-key'] === 'string' ? request.headers['x-api-key'].trim() : '';
  const suppliedKey = bearer || headerKey;
  const expected = Buffer.from(AUTOMATION_API_KEY);
  const supplied = Buffer.from(suppliedKey);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

function requireAutomationApiKey(request, response) {
  if (isAuthorizedAutomationRequest(request)) return true;
  sendJson(response, AUTOMATION_API_KEY ? 401 : 503, {
    error: AUTOMATION_API_KEY ? '缺少或无效的 API Key' : '服务端未配置 AUTOMATION_API_KEY',
  });
  return false;
}

function requestBody(request) {
  return new Promise((resolvePromise, rejectPromise) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) rejectPromise(new Error('请求体过大'));
    });
    request.on('end', () => resolvePromise(body));
    request.on('error', rejectPromise);
  });
}

function videoUrl(videoPath, videoRoot, urlPrefix) {
  if (!videoPath) return '';
  const absolutePath = resolve(videoPath);
  const relativePath = relative(videoRoot, absolutePath);
  if (!relativePath || relativePath.startsWith('..')) return '';
  return `${urlPrefix}/${relativePath.split(/[/\\\\]/).map(encodeURIComponent).join('/')}`;
}

function videoUrlForAnyVideoPath(videoPath) {
  if (!videoPath) return '';
  const absolutePath = resolve(videoPath);
  const legacyRelativePath = relative(LEGACY_VIDEO_ROOT, absolutePath);
  if (legacyRelativePath && !legacyRelativePath.startsWith('..')) {
    return videoUrl(absolutePath, LEGACY_VIDEO_ROOT, '/videos');
  }
  return videoUrl(absolutePath, QUICK_TEST_VIDEO_ROOT, '/quick-test-videos');
}

function drainAutomationQueue() {
  while (activeAutomations < MAX_CONCURRENT_AUTOMATIONS && AUTOMATION_QUEUE.length > 0) {
    const queued = AUTOMATION_QUEUE.shift();
    activeAutomations += 1;
    Promise.resolve()
      .then(() => {
        queued.onStart?.();
        return queued.task();
      })
      .then(queued.resolve, queued.reject)
      .finally(() => {
        activeAutomations -= 1;
        drainAutomationQueue();
      });
  }
}

function enqueueAutomation(task, onStart) {
  return new Promise((resolvePromise, rejectPromise) => {
    AUTOMATION_QUEUE.push({ task, onStart, resolve: resolvePromise, reject: rejectPromise });
    drainAutomationQueue();
  });
}

function executeAutomation(
  index,
  targetUrl,
  runDirectory,
  {
    dryRun = false,
    outputDir = QUICK_TEST_VIDEO_ROOT,
    videoRoot = QUICK_TEST_VIDEO_ROOT,
    videoUrlPrefix = '/quick-test-videos',
  } = {},
) {
  const resultFile = resolve(runDirectory, `result-${index}.json`);
  const command = process.platform === 'win32' ? resolve(PROJECT_DIR, 'node_modules', '.bin', 'tsx.cmd') : resolve(PROJECT_DIR, 'node_modules', '.bin', 'tsx');
  const startedAt = Date.now();
  const runId = basename(runDirectory);
  const label = `快速测试 ${runId} / 第 ${index} 项`;
  appendServerLog('INFO', `${label} 开始执行`);
  return new Promise((resolvePromise) => {
    const childArguments = [RUNNER_SCRIPT, targetUrl, `--result-file=${resultFile}`, `--seed=${Date.now() + index}`, `--output-dir=${outputDir}`];
    if (dryRun) childArguments.push('--dry-run');
    const child = spawn(command, childArguments, {
      cwd: PROJECT_DIR,
      env: { ...process.env, AUTOMATION_LOG_FILE: LOG_FILE },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    ACTIVE_CHILDREN.add(child);
    let errorOutput = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      const outcome = result.successful ? '执行成功' : `执行失败：${result.error || '未知错误'}`;
      appendServerLog(result.successful ? 'INFO' : 'ERROR', `${label} ${outcome}，耗时 ${result.duration}`);
      resolvePromise(result);
    };
    child.stderr.on('data', (chunk) => {
      if (errorOutput.length >= MAX_ERROR_OUTPUT_LENGTH) return;
      errorOutput += chunk.toString().slice(0, MAX_ERROR_OUTPUT_LENGTH - errorOutput.length);
    });
    child.on('error', (error) => {
      ACTIVE_CHILDREN.delete(child);
      finish({ index, successful: false, duration: `${((Date.now() - startedAt) / 1000).toFixed(1)}s`, error: error.message });
    });
    child.on('close', async (code) => {
      ACTIVE_CHILDREN.delete(child);
      let result = null;
      try { result = JSON.parse(await readFile(resultFile, 'utf8')); } catch { /* runner may fail before writing a result */ }
      finish({ index, successful: Boolean(result?.success) && code === 0, duration: `${((Date.now() - startedAt) / 1000).toFixed(1)}s`, error: result?.error || errorOutput.trim() || (code === 0 ? '' : `自动化脚本退出码：${code}`), videoUrl: videoUrl(result?.videoPath, videoRoot, videoUrlPrefix), videoPath: result?.videoPath || '' });
    });
  });
}

function runAutomation(index, targetUrl, runDirectory, onStart, options) {
  return enqueueAutomation(() => executeAutomation(index, targetUrl, runDirectory, options), onStart);
}

function createQuickTestRun({ targetUrl, total, concurrency }) {
  const run = {
    runId: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    targetUrl,
    total,
    concurrency,
    status: 'running',
    startedAt: Date.now(),
    completedAt: null,
    results: Array.from({ length: total }, (_, offset) => ({ index: offset + 1, status: 'queued', successful: false, duration: '—', videoUrl: '', videoPath: '', error: '', deleted: false })),
  };
  QUICK_TEST_RUNS.set(run.runId, run);
  persistRun(run);
  return run;
}

function publicRun(run) {
  const allResults = run.results.filter((item) => !item.deleted);
  const completed = run.results.filter((item) => item.status === 'success' || item.status === 'failed').length;
  const success = run.results.filter((item) => item.status === 'success').length;
  const failed = run.results.filter((item) => item.status === 'failed').length;
  return {
    runId: run.runId,
    targetUrl: run.targetUrl,
    total: run.total,
    concurrency: run.concurrency,
    status: run.status,
    done: run.status === 'completed',
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    completedCount: completed,
    success,
    failed,
    queue: {
      active: activeAutomations,
      waiting: AUTOMATION_QUEUE.length,
      limit: MAX_CONCURRENT_AUTOMATIONS,
    },
    results: allResults.map(({ videoPath, deleted, ...result }) => result),
  };
}

async function executeQuickTestRun(run) {
  const runDirectory = runDirectoryFor(run.runId);
  await mkdir(runDirectory, { recursive: true });
  try {
    let nextIndex = 1;
    const worker = async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index > run.total) return;
        let result;
        try {
          result = await runAutomation(
            index,
            run.targetUrl,
            runDirectory,
            () => {
              run.results[index - 1].status = 'running';
              persistRun(run);
            },
          );
        } catch (error) {
          result = { index, successful: false, duration: '—', error: error.message || '自动化测试执行失败', videoUrl: '', videoPath: '' };
        }
        const resultIndex = result.index - 1;
        run.results[resultIndex] = { ...run.results[resultIndex], status: result.successful ? 'success' : 'failed', successful: result.successful, duration: result.duration, error: result.error || '', videoUrl: result.videoUrl || '', videoPath: result.videoPath || '' };
        persistRun(run);
      }
    };
    await Promise.all(Array.from({ length: Math.min(run.concurrency, run.total) }, () => worker()));
  } finally {
    run.status = 'completed';
    run.completedAt = Date.now();
    persistRun(run);
  }
}

function normalizeAutomationLinks(payload) {
  if (!Array.isArray(payload?.links) || payload.links.length < 1 || payload.links.length > MAX_AUTOMATION_LINKS) {
    throw new Error(`links 必须是 1–${MAX_AUTOMATION_LINKS} 条链接的数组`);
  }
  return payload.links.map((item, index) => {
    const rawUrl = typeof item === 'string' ? item : item?.url;
    const url = typeof rawUrl === 'string' ? rawUrl.trim() : '';
    if (!url) throw new Error(`第 ${index + 1} 条链接为空`);
    let parsedUrl;
    try { parsedUrl = new URL(url); } catch { throw new Error(`第 ${index + 1} 条链接不是有效 URL`); }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error(`第 ${index + 1} 条链接必须使用 HTTP 或 HTTPS`);
    if (!parsedUrl.href.includes('temp-lp-jing')) throw new Error(`第 ${index + 1} 条链接必须包含模板标识 temp-lp-jing`);
    const name = typeof item === 'object' && typeof item?.name === 'string' && item.name.trim()
      ? item.name.trim().slice(0, 100)
      : `任务 ${index + 1}`;
    return { index: index + 1, name, url };
  });
}

function normalizeAutomationConcurrency(value) {
  const concurrency = value === undefined ? 1 : Number.parseInt(value, 10);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_AUTOMATION_CONCURRENCY) {
    throw new Error(`concurrency 必须是 1–${MAX_AUTOMATION_CONCURRENCY} 之间的整数`);
  }
  return concurrency;
}

function createAutomationJob({ links, concurrency, dryRun }) {
  const job = {
    jobId: `job-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    links,
    total: links.length,
    concurrency,
    dryRun,
    status: 'running',
    startedAt: Date.now(),
    completedAt: null,
    results: links.map((item) => ({
      index: item.index,
      name: item.name,
      url: item.url,
      status: 'queued',
      success: false,
      duration: '—',
      videoUrl: '',
      videoPath: '',
      error: '',
    })),
  };
  AUTOMATION_JOBS.set(job.jobId, job);
  persistAutomationJob(job);
  return job;
}

function publicAutomationJob(job) {
  const completed = job.results.filter((item) => item.status === 'success' || item.status === 'failed').length;
  const success = job.results.filter((item) => item.status === 'success').length;
  const failed = job.results.filter((item) => item.status === 'failed').length;
  return {
    jobId: job.jobId,
    total: job.total,
    concurrency: job.concurrency,
    dryRun: job.dryRun,
    status: job.status,
    done: job.status === 'completed',
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    completedCount: completed,
    success,
    failed,
    queue: {
      active: activeAutomations,
      waiting: AUTOMATION_QUEUE.length,
      limit: MAX_CONCURRENT_AUTOMATIONS,
    },
    results: job.results.map((result) => {
      const videoUrl = result.videoUrl || videoUrlForAnyVideoPath(result.videoPath);
      const { videoPath, ...publicResult } = result;
      return { ...publicResult, videoUrl };
    }),
  };
}

async function executeAutomationJob(job) {
  const jobDirectory = automationJobDirectoryFor(job.jobId);
  await mkdir(jobDirectory, { recursive: true });
  try {
    let nextIndex = 0;
    const worker = async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= job.links.length) return;
        const item = job.links[index];
        let result;
        try {
          result = await runAutomation(
            item.index,
            item.url,
            jobDirectory,
            () => {
              job.results[index].status = 'running';
              persistAutomationJob(job);
            },
            {
              dryRun: job.dryRun,
              outputDir: LEGACY_VIDEO_ROOT,
              videoRoot: LEGACY_VIDEO_ROOT,
              videoUrlPrefix: '/videos',
            },
          );
        } catch (error) {
          result = {
            index: item.index,
            successful: false,
            duration: '—',
            error: error instanceof Error ? error.message : String(error),
            videoUrl: '',
            videoPath: '',
          };
        }
        job.results[index] = {
          ...job.results[index],
          status: result.successful ? 'success' : 'failed',
          success: result.successful,
          duration: result.duration,
          error: result.error || '',
          videoUrl: result.videoUrl || '',
          videoPath: result.videoPath || '',
        };
        persistAutomationJob(job);
      }
    };
    await Promise.all(Array.from({ length: Math.min(job.concurrency, job.total) }, () => worker()));
  } finally {
    job.status = 'completed';
    job.completedAt = Date.now();
    persistAutomationJob(job);
  }
}

async function createAutomationJobApi(request, response) {
  if (request.method !== 'POST') { sendJson(response, 405, { error: '只支持 POST 请求' }); return; }
  let payload;
  try { payload = JSON.parse(await requestBody(request)); } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : '请求参数不是有效 JSON' });
    return;
  }
  let links;
  let concurrency;
  try {
    links = normalizeAutomationLinks(payload);
    concurrency = normalizeAutomationConcurrency(payload.concurrency);
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    return;
  }
  if (payload.dryRun !== undefined && typeof payload.dryRun !== 'boolean') {
    sendJson(response, 400, { error: 'dryRun 必须是布尔值' });
    return;
  }
  const job = createAutomationJob({ links, concurrency, dryRun: payload.dryRun === true });
  void executeAutomationJob(job).catch((error) => {
    appendServerLog('ERROR', `自动化 API 任务 ${job.jobId} 执行异常：${error instanceof Error ? error.message : String(error)}`);
    job.results.forEach((result) => {
      if (result.status === 'queued' || result.status === 'running') {
        result.status = 'failed';
        result.error = error instanceof Error ? error.message : String(error);
      }
    });
    job.status = 'completed';
    job.completedAt = Date.now();
    persistAutomationJob(job);
  });
  sendJson(response, 202, publicAutomationJob(job));
}

async function handleAutomationApi(request, response) {
  const pathname = new URL(request.url || '/', 'http://automation.local').pathname;
  if (pathname === '/api/automation/health' && request.method === 'GET') {
    sendJson(response, 200, {
      service: 'automation-api',
      apiKeyConfigured: Boolean(AUTOMATION_API_KEY),
      maxLinks: MAX_AUTOMATION_LINKS,
      maxConcurrency: MAX_CONCURRENT_AUTOMATIONS,
    });
    return;
  }
  if (!requireAutomationApiKey(request, response)) return;
  if (pathname === '/api/automation/jobs') {
    if (request.method !== 'POST') { sendJson(response, 405, { error: '只支持 POST 请求' }); return; }
    await createAutomationJobApi(request, response);
    return;
  }
  const jobMatch = pathname.match(/^\/api\/automation\/jobs\/([^/]+)$/);
  if (jobMatch && request.method === 'GET') {
    const job = AUTOMATION_JOBS.get(jobMatch[1]);
    if (!job) { sendJson(response, 404, { error: '任务不存在或服务已重启' }); return; }
    sendJson(response, 200, publicAutomationJob(job));
    return;
  }
  sendJson(response, 405, { error: '不支持的自动化 API 请求' });
}

function removeVideo(videoPath) {
  if (!videoPath) return;
  const absolutePath = resolve(videoPath);
  const relativePath = relative(QUICK_TEST_VIDEO_ROOT, absolutePath);
  if (!relativePath || relativePath.startsWith('..')) throw new Error('视频路径不在允许的输出目录内');
  if (existsSync(absolutePath)) unlinkSync(absolutePath);
}

async function removeRunArtifacts(run) {
  for (const result of run.results) {
    try {
      removeVideo(result.videoPath);
    } catch (error) {
      appendServerLog('ERROR', `删除快速测试视频失败（${run.runId}）：${error.message}`);
    }
  }
  await rm(runDirectoryFor(run.runId), { recursive: true, force: true });
}

async function deleteAllQuickTestRuns(request, response) {
  if (request.method !== 'DELETE') { sendJson(response, 405, { error: '只支持 DELETE 请求' }); return; }
  const runs = [...QUICK_TEST_RUNS.values()];
  const activeRuns = runs.filter((run) => run.status !== 'completed');
  if (activeRuns.length > 0) {
    sendJson(response, 409, { error: '执行中的测试完成后才能全部删除' });
    return;
  }
  try {
    await Promise.all(runs.map((run) => removeRunArtifacts(run)));
    QUICK_TEST_RUNS.clear();
    sendJson(response, 200, { runs: [] });
  } catch (error) {
    sendJson(response, 500, { error: error.message || '全部删除失败' });
  }
}

async function createQuickTest(request, response) {
  if (request.method !== 'POST') { sendJson(response, 405, { error: '只支持 POST 请求' }); return; }
  let payload;
  try { payload = JSON.parse(await requestBody(request)); } catch (error) { sendJson(response, 400, { error: error.message || '请求参数不是有效 JSON' }); return; }
  const targetUrl = typeof payload?.url === 'string' ? payload.url.trim() : '';
  const total = Number.parseInt(payload?.count, 10);
  const concurrency = Number.parseInt(payload?.concurrency, 10);
  if (!targetUrl || !Number.isInteger(total) || total < 1 || total > 50 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) {
    sendJson(response, 400, { error: '链接、测试次数或并发数量不符合要求' });
    return;
  }

  const run = createQuickTestRun({ targetUrl, total, concurrency });
  void executeQuickTestRun(run).catch((error) => {
    appendServerLog('ERROR', `快速测试任务 ${run.runId} 执行异常：${error instanceof Error ? error.message : String(error)}`);
    run.results.forEach((result) => {
      if (result.status === 'queued' || result.status === 'running') {
        result.status = 'failed';
        result.error = error.message || '自动化测试执行失败';
      }
    });
    run.status = 'completed';
    run.completedAt = Date.now();
    persistRun(run);
  });
  sendJson(response, 202, publicRun(run));
}

async function updateQuickTestResult(request, response, runId, indexText) {
  const run = QUICK_TEST_RUNS.get(runId);
  const index = Number.parseInt(indexText, 10);
  if (!run) { sendJson(response, 404, { error: '测试记录不存在或服务已重启' }); return; }
  if (!Number.isInteger(index) || index < 1 || index > run.total) { sendJson(response, 400, { error: '测试记录编号无效' }); return; }
  if (run.status !== 'completed') { sendJson(response, 409, { error: '测试执行完成后才能删除记录或视频' }); return; }
  const result = run.results[index - 1];
  if (!result || result.deleted) { sendJson(response, 404, { error: '测试记录不存在' }); return; }
  try {
    removeVideo(result.videoPath);
    result.videoPath = '';
    result.videoUrl = '';
    result.deleted = true;
    persistRun(run);
    sendJson(response, 200, publicRun(run));
  } catch (error) {
    sendJson(response, 500, { error: error.message || '删除记录失败' });
  }
}

async function handleQuickTestApi(request, response) {
  const pathname = new URL(request.url || '/', 'http://quick-test.local').pathname;
  if (pathname === '/api/quick-test/runs' && request.method === 'DELETE') {
    await deleteAllQuickTestRuns(request, response);
    return;
  }
  if (pathname === '/api/quick-test/runs' && request.method === 'GET') {
    const runs = [...QUICK_TEST_RUNS.values()]
      .sort((left, right) => (right.startedAt || 0) - (left.startedAt || 0))
      .map(publicRun)
      .filter((run) => run.results.length > 0 || !run.done);
    sendJson(response, 200, { runs });
    return;
  }
  if (pathname === '/api/quick-test/run') { await createQuickTest(request, response); return; }
  const resultMatch = pathname.match(/^\/api\/quick-test\/run\/([^/]+)\/results\/(\d+)$/);
  if (resultMatch && request.method === 'DELETE') { await updateQuickTestResult(request, response, resultMatch[1], resultMatch[2]); return; }
  const runMatch = pathname.match(/^\/api\/quick-test\/run\/([^/]+)$/);
  if (runMatch && request.method === 'GET') {
    const run = QUICK_TEST_RUNS.get(runMatch[1]);
    if (!run) { sendJson(response, 404, { error: '测试任务不存在或服务已重启' }); return; }
    sendJson(response, 200, publicRun(run));
    return;
  }
  sendJson(response, 405, { error: '不支持的快速测试接口请求' });
}

function serveVideo(filePath, request, response) {
  const fileStats = statSync(filePath);
  const contentType = CONTENT_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream';
  const headers = { 'Content-Type': contentType, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  const query = new URL(request.url || '/', 'http://quick-test.local').searchParams;
  if (query.get('download') === '1') headers['Content-Disposition'] = `attachment; filename="${basename(filePath)}"`;
  const range = request.headers.range;
  if (!range) { response.writeHead(200, { ...headers, 'Content-Length': fileStats.size }); createReadStream(filePath).pipe(response); return; }
  const match = range.match(/bytes=(\d*)-(\d*)/);
  if (!match) { response.writeHead(416, { 'Content-Range': `bytes */${fileStats.size}` }); response.end(); return; }
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Number(match[2]) : fileStats.size - 1;
  if (start > end || start >= fileStats.size) { response.writeHead(416, { 'Content-Range': `bytes */${fileStats.size}` }); response.end(); return; }
  const boundedEnd = Math.min(end, fileStats.size - 1);
  response.writeHead(206, { ...headers, 'Content-Length': boundedEnd - start + 1, 'Content-Range': `bytes ${start}-${boundedEnd}/${fileStats.size}` });
  createReadStream(filePath, { start, end: boundedEnd }).pipe(response);
}

function serveCommand(options) {
  if (!existsSync(WEB_ROOT)) throw new Error(`找不到前端目录：${WEB_ROOT}`);
  ensureOutputDir();
  loadPersistedRuns();
  loadPersistedAutomationJobs();
  const server = createServer((request, response) => {
    if ((request.url || '').split('?')[0] === '/api/quick-test/health') { sendJson(response, 200, { service: 'quick-test-server', pid: process.pid, port: options.port }); return; }
    if ((request.url || '').split('?')[0].startsWith('/api/automation/')) {
      handleAutomationApi(request, response).catch((error) => {
        appendServerLog('ERROR', `自动化 API 接口处理失败：${error instanceof Error ? error.message : String(error)}`);
        if (!response.headersSent) sendJson(response, 500, { error: error instanceof Error ? error.message : '自动化 API 执行失败' });
      });
      return;
    }
    if ((request.url || '').split('?')[0].startsWith('/api/quick-test/run')) {
      handleQuickTestApi(request, response).catch((error) => {
        appendServerLog('ERROR', `快速测试接口处理失败：${error instanceof Error ? error.message : String(error)}`);
        sendJson(response, 500, { error: error.message || '自动化测试执行失败' });
      });
      return;
    }
    const videoPath = safeVideoPath(request.url || '/');
    if (videoPath) {
      try { if (!statSync(videoPath).isFile()) throw new Error('Not found'); serveVideo(videoPath, request, response); } catch { response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('Not found'); }
      return;
    }
    const filePath = safeWebPath(request.url || '/');
    if (!filePath) { response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('Not found'); return; }
    let actualPath = filePath;
    try {
      if (statSync(actualPath).isDirectory()) actualPath = join(actualPath, 'index.html');
      const body = readFileSync(actualPath);
      response.writeHead(200, { 'Content-Type': CONTENT_TYPES[extname(actualPath).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      response.end(body);
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('Not found');
    }
  });

  const cleanup = () => { const state = readState(options.port); if (state?.pid === process.pid) removeState(options.port); };
  let shuttingDown = false;
  let serverClosed = false;
  const finishShutdown = () => {
    if (serverClosed && ACTIVE_CHILDREN.size === 0) {
      cleanup();
      process.exit(0);
    }
  };
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of ACTIVE_CHILDREN) {
      child.once('close', finishShutdown);
      try { child.kill('SIGTERM'); } catch { /* best effort cleanup */ }
    }
    server.close(() => { serverClosed = true; finishShutdown(); });
    setTimeout(() => {
      for (const child of ACTIVE_CHILDREN) {
        try { child.kill('SIGKILL'); } catch { /* best effort cleanup */ }
      }
      cleanup();
      process.exit(1);
    }, 3_000).unref();
  };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  server.on('error', (error) => { appendServerLog('ERROR', `快速测试服务启动失败：${error.message}`); cleanup(); process.exit(1); });
  server.listen(options.port, options.host, () => { writeState({ pid: process.pid, port: options.port, host: options.host, startedAt: new Date().toISOString() }); appendServerLog('INFO', `快速测试页面已启动：${displayAccessUrls(options.host, options.port)}`); });
}

async function startCommand(args) {
  const options = parseOptions(args); const current = readState(options.port);
  if (current && isRunning(current.pid)) { commandLog('INFO', `服务已经在运行：${displayAccessUrls(current.host, current.port)}`); return; }
  removeState(options.port);
  await stopOrphanedQuickTestServer(options);
  ensureOutputDir(); const logHandle = openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve', '--port', String(options.port), '--host', options.host], { cwd: PROJECT_DIR, detached: true, stdio: ['ignore', logHandle, logHandle] });
  let spawnError;
  child.once('error', (error) => { spawnError = error; });
  child.unref();
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (spawnError) throw new Error(`无法启动服务：${spawnError.message}`);
    const state = readState(options.port);
    if (state?.pid === child.pid && isRunning(child.pid)) {
      commandLog('INFO', `快速测试页面已启动：${displayAccessUrls(options.host, options.port)}`); commandLog('INFO', `日志文件：${LOG_FILE}`); return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  if (isRunning(child.pid)) { try { process.kill(child.pid); } catch { /* best effort cleanup */ } }
  throw new Error(`服务启动失败或端口 ${options.port} 已被占用，请查看日志：${LOG_FILE}`);
}

async function stopCommand(args) {
  const options = parseOptions(args); const current = readState(options.port); if (!current || !isRunning(current.pid)) { removeState(options.port); commandLog('INFO', '快速测试服务当前未运行。'); return; }
  try { process.kill(current.pid); } catch (error) { throw new Error(`无法停止服务（PID ${current.pid}）：${error.message}`); }
  const deadline = Date.now() + 3000; while (isRunning(current.pid) && Date.now() < deadline) await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  if (isRunning(current.pid)) throw new Error(`服务仍在运行，请手动结束进程 PID ${current.pid}`);
  removeState(options.port); commandLog('INFO', '快速测试服务已停止。');
}

function statusCommand(args) { const options = parseOptions(args); const current = readState(options.port); if (!current || !isRunning(current.pid)) { removeState(options.port); commandLog('INFO', '快速测试服务当前未运行。'); return; } commandLog('INFO', `快速测试服务运行中：${displayAccessUrls(current.host, current.port)}（PID ${current.pid}）`); }

async function main() {
  const [command = 'restart', ...args] = process.argv.slice(2);
  if (command === 'serve') serveCommand(parseOptions(args));
  else if (command === 'start') await startCommand(args);
  else if (command === 'restart') { await stopCommand(args); await startCommand(args); }
  else if (command === 'stop') await stopCommand(args);
  else if (command === 'status') statusCommand(args);
  else throw new Error(`未知命令：${command}。可用命令：start、restart、stop、status`);
}

main().catch((error) => { commandLog('ERROR', `错误：${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
