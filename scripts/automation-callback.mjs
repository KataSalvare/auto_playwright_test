import { stat } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_DELAYS_MS = Object.freeze([5_000, 10_000, 30_000]);

const sleep = (durationMs) => new Promise((resolvePromise) => setTimeout(resolvePromise, durationMs));

async function videoFileSize(videoPath) {
  if (!videoPath) return undefined;
  try {
    return (await stat(videoPath)).size;
  } catch {
    return undefined;
  }
}

export async function createAutomationCallbackPayload({
  jobId,
  orderNo,
  successful,
  videoUrl,
  videoPath,
  error,
  completedAt,
}) {
  const callbackCompletedAt = Number.isFinite(completedAt) ? completedAt : Date.now();
  if (!successful || !videoUrl) {
    return {
      jobId,
      orderNo,
      status: 'failed',
      error: error || (successful ? '自动化执行成功，但未生成可下载的视频' : '自动化执行失败'),
      completedAt: callbackCompletedAt,
    };
  }

  const payload = {
    jobId,
    orderNo,
    status: 'success',
    videoUrl,
    completedAt: callbackCompletedAt,
  };
  const fileSize = await videoFileSize(videoPath);
  if (fileSize !== undefined) payload.fileSize = fileSize;
  return payload;
}

export function postAutomationCallback({ url, apiKey, payload, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolvePromise, rejectPromise) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      rejectPromise(new Error('回调地址不是有效 URL'));
      return;
    }
    if (!['http:', 'https:'].includes(target.protocol)) {
      rejectPromise(new Error('回调地址必须使用 HTTP 或 HTTPS'));
      return;
    }

    const body = JSON.stringify(payload);
    const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Authorization: `Bearer ${apiKey}`,
      },
      timeout: timeoutMs,
    }, (response) => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { responseBody += chunk; });
      response.on('end', () => {
        resolvePromise({ statusCode: response.statusCode || 0, body: responseBody });
      });
    });

    request.on('timeout', () => request.destroy(new Error(`回调请求超过 ${timeoutMs}ms`)));
    request.on('error', rejectPromise);
    request.end(body);
  });
}

export function createAutomationCallbackDelivery({
  url,
  apiKey,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  transport = postAutomationCallback,
  wait = sleep,
} = {}) {
  const configured = Boolean(url && apiKey);

  return {
    configured,
    async deliver(callbackResult, { onAttempt } = {}) {
      if (!configured) {
        return {
          success: false,
          attempts: 0,
          completedAt: Date.now(),
          error: '未配置回调地址或回调 API Key',
        };
      }

      const payload = await createAutomationCallbackPayload(callbackResult);
      const totalAttempts = retryDelaysMs.length + 1;
      let lastError = '';

      for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
        await onAttempt?.({ attempt, payload });
        try {
          const response = await transport({ url, apiKey, payload, timeoutMs });
          if (response.statusCode === 200) {
            return { success: true, attempts: attempt, completedAt: Date.now(), error: '', payload };
          }
          lastError = `回调接口返回 HTTP ${response.statusCode}${response.body ? `：${response.body}` : ''}`;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }

        if (attempt < totalAttempts) await wait(retryDelaysMs[attempt - 1]);
      }

      return {
        success: false,
        attempts: totalAttempts,
        completedAt: Date.now(),
        error: lastError || '回调发送失败',
        payload,
      };
    },
  };
}
