import { automationConfig } from '../automation.config';
import { automationQueueConfig } from '../automation.queue.config';
import { formatDuration, logger } from '../src/automation/logger';
import { runOrderFlow } from '../src/automation/order-flow';
import { parseOrderUrl, safeUrlDescription } from '../src/automation/url-config';
import type { AutomationOptions } from '../src/automation/types';

const MAX_CONCURRENCY = 10;

type QueueLink = {
  name?: string;
  url: string;
};

type QueueResult = {
  index: number;
  name: string;
  success: boolean;
  duration: string;
  error?: string;
};

function parseDryRun(): boolean {
  const argumentsList = process.argv.slice(2);
  const unknownArgument = argumentsList.find((argument) => argument !== '--dry-run');
  if (unknownArgument) throw new Error(`不支持的命令行参数：${unknownArgument}`);
  return argumentsList.includes('--dry-run');
}

function validateConfig(): { concurrency: number; links: QueueLink[] } {
  const { concurrency, links } = automationQueueConfig;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw new Error(`automation.queue.config.ts 的 concurrency 必须是 1–${MAX_CONCURRENCY} 之间的整数`);
  }
  if (!Array.isArray(links) || links.length === 0) {
    throw new Error('automation.queue.config.ts 的 links 不能为空');
  }

  const normalizedLinks = links.map((item, index) => {
    if (!item || typeof item.url !== 'string' || !item.url.trim()) {
      throw new Error(`队列第 ${index + 1} 项缺少有效的 url`);
    }
    return { name: item.name?.trim() || `任务 ${index + 1}`, url: item.url.trim() };
  });
  return { concurrency, links: normalizedLinks };
}

function createOptions(index: number): AutomationOptions {
  return {
    seed: Date.now() + index,
    product: 'basic',
    waitAgreement: true,
    waitProduct: true,
    headless: automationConfig.headless,
    deleteFailedVideo: automationConfig.deleteFailedVideo,
    outputDir: automationConfig.outputDir,
  };
}

async function runQueueItem(item: QueueLink, index: number, total: number, dryRun: boolean): Promise<QueueResult> {
  const startedAt = Date.now();
  const label = `[${index + 1}/${total}] ${item.name}`;
  try {
    const order = parseOrderUrl(item.url);
    logger.info(`${label} 开始执行：${safeUrlDescription(item.url)}，流程 ${order.pageOrder}`);
    if (dryRun) {
      logger.info(`${label} 执行成功，耗时 0.0s，结果：参数校验通过（dry-run）`);
      return { index, name: item.name || `任务 ${index + 1}`, success: true, duration: '0.0s' };
    }

    const result = await runOrderFlow(order, createOptions(index));
    const duration = formatDuration(startedAt);
    logger.info(`${label} 执行成功，耗时 ${duration}${result.videoPath ? `，视频：${result.videoPath}` : ''}`);
    return { index, name: item.name || `任务 ${index + 1}`, success: true, duration };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const duration = formatDuration(startedAt);
    logger.error(`${label} 执行失败，耗时 ${duration}`, error);
    return { index, name: item.name || `任务 ${index + 1}`, success: false, duration, error: message };
  }
}

async function main() {
  const startedAt = Date.now();
  const dryRun = parseDryRun();
  const { concurrency, links } = validateConfig();
  const results: QueueResult[] = [];
  let nextIndex = 0;

  logger.info(`命令行测试队列开始：${links.length} 条链接，最大并发 ${concurrency}${dryRun ? '，dry-run 模式' : ''}`);
  links.forEach((item, index) => logger.info(`[${index + 1}/${links.length}] ${item.name} 已进入队列`));

  async function worker() {
    while (nextIndex < links.length) {
      const index = nextIndex;
      nextIndex += 1;
      results.push(await runQueueItem(links[index], index, links.length, dryRun));
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, links.length) }, () => worker()));

  const failed = results.filter((result) => !result.success);
  logger.info(`队列执行完成：${links.length - failed.length} 条成功，${failed.length} 条失败，命令耗时 ${formatDuration(startedAt)}`);
  if (failed.length > 0) {
    logger.error('失败任务：');
    failed.sort((left, right) => left.index - right.index).forEach((result) => {
      logger.error(`- ${result.name}：${result.error}`);
    });
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  logger.error('命令行测试队列失败', error);
  process.exitCode = 1;
});
