import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { logger } from '../../src/automation/logger';

test('并发订单的步骤日志保留各自上下文', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'automation-logger-'));
  const logPath = join(directory, 'automation.log');
  const previousLogPath = process.env.AUTOMATION_LOG_FILE;
  process.env.AUTOMATION_LOG_FILE = logPath;

  try {
    await Promise.all([
      logger.withContext('订单 A / 流程 1', async () => {
        logger.info('步骤 A1');
        await Promise.resolve();
        logger.info('步骤 A2');
      }),
      logger.withContext('订单 B / 流程 2', async () => {
        logger.info('步骤 B1');
        await Promise.resolve();
        logger.info('步骤 B2');
      }),
    ]);

    const content = await readFile(logPath, 'utf8');
    expect(content).toContain('[订单 A / 流程 1] 步骤 A1');
    expect(content).toContain('[订单 A / 流程 1] 步骤 A2');
    expect(content).toContain('[订单 B / 流程 2] 步骤 B1');
    expect(content).toContain('[订单 B / 流程 2] 步骤 B2');
  } finally {
    if (previousLogPath === undefined) delete process.env.AUTOMATION_LOG_FILE;
    else process.env.AUTOMATION_LOG_FILE = previousLogPath;
    await rm(directory, { recursive: true, force: true });
  }
});
