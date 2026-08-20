import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  createAutomationCallbackDelivery,
  createAutomationCallbackPayload,
} from '../../scripts/automation-callback.mjs';

test('成功回调不包含 planNo，并携带实际文件大小', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'automation-callback-'));
  const videoPath = join(directory, 'result.mp4');
  await writeFile(videoPath, Buffer.alloc(1234));
  try {
    const payload = await createAutomationCallbackPayload({
      jobId: 'job-1',
      orderNo: 'ORDER001',
      successful: true,
      videoUrl: '/videos/success/result.mp4',
      videoPath,
      completedAt: 123456,
    });
    expect(payload).toEqual({
      jobId: 'job-1',
      orderNo: 'ORDER001',
      status: 'success',
      videoUrl: '/videos/success/result.mp4',
      fileSize: 1234,
      completedAt: 123456,
    });
    expect(payload).not.toHaveProperty('planNo');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('没有可下载视频时按失败结果回调', async () => {
  const payload = await createAutomationCallbackPayload({
    jobId: 'job-2',
    orderNo: 'ORDER002',
    successful: true,
    videoUrl: '',
    completedAt: 456789,
  });
  expect(payload).toEqual({
    jobId: 'job-2',
    orderNo: 'ORDER002',
    status: 'failed',
    error: '自动化执行成功，但未生成可下载的视频',
    completedAt: 456789,
  });
});

test('HTTP 非 200 时按 5、10、30 秒间隔重试', async () => {
  const delays = [];
  const requests = [];
  const delivery = createAutomationCallbackDelivery({
    url: 'http://callback.example.test/api/callback',
    apiKey: 'secret',
    retryDelaysMs: [5_000, 10_000, 30_000],
    wait: async (durationMs) => { delays.push(durationMs); },
    transport: async (request) => {
      requests.push(request);
      return { statusCode: requests.length === 4 ? 200 : 500, body: 'failed' };
    },
  });

  const outcome = await delivery.deliver({
    jobId: 'job-3',
    orderNo: 'ORDER003',
    successful: false,
    error: '页面超时',
    completedAt: 789012,
  });

  expect(outcome.success).toBe(true);
  expect(outcome.attempts).toBe(4);
  expect(delays).toEqual([5_000, 10_000, 30_000]);
  expect(requests).toHaveLength(4);
  expect(requests[0].payload.status).toBe('failed');
});

test('连续失败时返回最终错误且不抛出异常', async () => {
  const delivery = createAutomationCallbackDelivery({
    url: 'http://callback.example.test/api/callback',
    apiKey: 'secret',
    retryDelaysMs: [1, 1, 1],
    wait: async () => {},
    transport: async () => { throw new Error('connection refused'); },
  });
  const outcome = await delivery.deliver({
    jobId: 'job-4',
    orderNo: 'ORDER004',
    successful: false,
    error: '录制失败',
  });
  expect(outcome.success).toBe(false);
  expect(outcome.attempts).toBe(4);
  expect(outcome.error).toBe('connection refused');
});

test('HTTP adapter 使用 Bearer 鉴权并发送约定 JSON', async () => {
  let receivedAuthorization = '';
  let receivedPayload;
  const server = createServer((request, response) => {
    receivedAuthorization = request.headers.authorization || '';
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      receivedPayload = JSON.parse(body);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"code":200,"message":"success"}');
    });
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('测试回调服务没有监听 TCP 端口');
    const delivery = createAutomationCallbackDelivery({
      url: `http://127.0.0.1:${address.port}/api/nw/record/callback`,
      apiKey: 'callback-secret',
      retryDelaysMs: [],
    });
    const outcome = await delivery.deliver({
      jobId: 'job-http',
      orderNo: 'ORDER-HTTP',
      successful: false,
      error: '录制失败',
      completedAt: 987654,
    });
    expect(outcome.success).toBe(true);
    expect(receivedAuthorization).toBe('Bearer callback-secret');
    expect(receivedPayload).toEqual({
      jobId: 'job-http',
      orderNo: 'ORDER-HTTP',
      status: 'failed',
      error: '录制失败',
      completedAt: 987654,
    });
  } finally {
    await new Promise((resolvePromise, rejectPromise) => server.close((error) => error ? rejectPromise(error) : resolvePromise()));
  }
});
