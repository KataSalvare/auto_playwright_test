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
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync, openSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const SCRIPT_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PROJECT_DIR = resolve(SCRIPT_DIR, '..');
const WEB_ROOT = resolve(PROJECT_DIR, 'web');
const OUTPUT_DIR = resolve(PROJECT_DIR, 'output');
const VIDEO_ROOT = resolve(OUTPUT_DIR, 'videos');
const QUICK_RUN_ROOT = resolve(OUTPUT_DIR, 'quick-test-runs');
const RUNNER_SCRIPT = resolve(PROJECT_DIR, 'scripts', 'quick-test-runner.ts');
const STATE_FILE = resolve(OUTPUT_DIR, 'quick-test-server.json');
const LOG_FILE = resolve(OUTPUT_DIR, 'quick-test-server.log');
const DEFAULT_PORT = 4173;
const DEFAULT_HOST = '127.0.0.1';

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
function readState() { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return null; } }
function removeState() { if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE); }
function isRunning(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } }
function writeState(state) { ensureOutputDir(); writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
function displayHost(host) { return host === '0.0.0.0' || host === '::' ? 'localhost' : host; }

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
  if (!pathname.startsWith('/videos/')) return null;
  const filePath = resolve(VIDEO_ROOT, `.${normalize(pathname.slice('/videos'.length))}`);
  const relativePath = relative(VIDEO_ROOT, filePath);
  if (!relativePath || relativePath.startsWith('..')) return null;
  return filePath;
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(payload));
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

function videoUrl(videoPath) {
  if (!videoPath) return '';
  const absolutePath = resolve(videoPath);
  const relativePath = relative(VIDEO_ROOT, absolutePath);
  if (!relativePath || relativePath.startsWith('..')) return '';
  return `/videos/${relativePath.split(/[/\\\\]/).map(encodeURIComponent).join('/')}`;
}

function runAutomation(index, targetUrl, runDirectory) {
  const resultFile = resolve(runDirectory, `result-${index}.json`);
  const command = process.platform === 'win32' ? resolve(PROJECT_DIR, 'node_modules', '.bin', 'tsx.cmd') : resolve(PROJECT_DIR, 'node_modules', '.bin', 'tsx');
  const startedAt = Date.now();
  return new Promise((resolvePromise) => {
    const child = spawn(command, [RUNNER_SCRIPT, targetUrl, `--result-file=${resultFile}`, `--seed=${Date.now() + index}`], { cwd: PROJECT_DIR, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let errorOutput = '';
    child.stderr.on('data', (chunk) => { errorOutput += chunk.toString(); });
    child.on('error', (error) => resolvePromise({ index, successful: false, duration: `${((Date.now() - startedAt) / 1000).toFixed(1)}s`, error: error.message }));
    child.on('close', async (code) => {
      let result = null;
      try { result = JSON.parse(await readFile(resultFile, 'utf8')); } catch { /* runner may fail before writing a result */ }
      resolvePromise({ index, successful: Boolean(result?.success) && code === 0, duration: `${((Date.now() - startedAt) / 1000).toFixed(1)}s`, error: result?.error || errorOutput.trim() || (code === 0 ? '' : `自动化脚本退出码：${code}`), videoUrl: videoUrl(result?.videoPath) });
    });
  });
}

async function executeQuickTest(request, response) {
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

  const runDirectory = resolve(QUICK_RUN_ROOT, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(runDirectory, { recursive: true });
  const results = [];
  for (let cursor = 0; cursor < total; cursor += concurrency) {
    const batch = Array.from({ length: Math.min(concurrency, total - cursor) }, (_, offset) => runAutomation(cursor + offset + 1, targetUrl, runDirectory));
    results.push(...await Promise.all(batch));
  }
  const success = results.filter((item) => item.successful).length;
  sendJson(response, 200, { total, concurrency, completed: results.length, success, failed: results.length - success, results: results.sort((left, right) => left.index - right.index) });
}

function serveVideo(filePath, request, response) {
  const fileStats = statSync(filePath);
  const contentType = CONTENT_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream';
  const headers = { 'Content-Type': contentType, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
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
  const server = createServer((request, response) => {
    if ((request.url || '').split('?')[0] === '/api/quick-test/run') { executeQuickTest(request, response).catch((error) => sendJson(response, 500, { error: error.message || '自动化测试执行失败' })); return; }
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

  const cleanup = () => { const state = readState(); if (state?.pid === process.pid) removeState(); };
  const shutdown = () => server.close(() => { cleanup(); process.exit(0); });
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  server.on('error', (error) => { console.error(`快速测试服务启动失败：${error.message}`); cleanup(); process.exit(1); });
  server.listen(options.port, options.host, () => { writeState({ pid: process.pid, port: options.port, host: options.host, startedAt: new Date().toISOString() }); console.log(`快速测试页面已启动：http://${displayHost(options.host)}:${options.port}/web/`); });
}

async function startCommand(args) {
  const options = parseOptions(args); const current = readState();
  if (current && isRunning(current.pid)) { console.log(`服务已经在运行：http://${displayHost(current.host)}:${current.port}/web/`); return; }
  removeState(); ensureOutputDir(); const logHandle = openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve', '--port', String(options.port), '--host', options.host], { cwd: PROJECT_DIR, detached: true, stdio: ['ignore', logHandle, logHandle] });
  let spawnError;
  child.once('error', (error) => { spawnError = error; });
  child.unref();
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (spawnError) throw new Error(`无法启动服务：${spawnError.message}`);
    const state = readState();
    if (state?.pid === child.pid && isRunning(child.pid)) {
      console.log(`快速测试页面已启动：http://${displayHost(options.host)}:${options.port}/web/`); console.log(`日志文件：${LOG_FILE}`); return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  if (isRunning(child.pid)) { try { process.kill(child.pid); } catch { /* best effort cleanup */ } }
  throw new Error(`服务启动失败或端口 ${options.port} 已被占用，请查看日志：${LOG_FILE}`);
}

async function stopCommand() {
  const current = readState(); if (!current || !isRunning(current.pid)) { removeState(); console.log('快速测试服务当前未运行。'); return; }
  try { process.kill(current.pid); } catch (error) { throw new Error(`无法停止服务（PID ${current.pid}）：${error.message}`); }
  const deadline = Date.now() + 3000; while (isRunning(current.pid) && Date.now() < deadline) await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  if (isRunning(current.pid)) throw new Error(`服务仍在运行，请手动结束进程 PID ${current.pid}`);
  removeState(); console.log('快速测试服务已停止。');
}

function statusCommand() { const current = readState(); if (!current || !isRunning(current.pid)) { removeState(); console.log('快速测试服务当前未运行。'); return; } console.log(`快速测试服务运行中：http://${displayHost(current.host)}:${current.port}/web/（PID ${current.pid}）`); }

async function main() {
  const [command = 'restart', ...args] = process.argv.slice(2);
  if (command === 'serve') serveCommand(parseOptions(args));
  else if (command === 'start') await startCommand(args);
  else if (command === 'restart') { await stopCommand(); await startCommand(args); }
  else if (command === 'stop') await stopCommand();
  else if (command === 'status') statusCommand();
  else throw new Error(`未知命令：${command}。可用命令：start、restart、stop、status`);
}

main().catch((error) => { console.error(`错误：${error.message}`); process.exitCode = 1; });
