import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const defaultLogFile = resolve('output/automation.log');
const logContext = new AsyncLocalStorage<string>();

function logFilePath() {
  return resolve(process.env.AUTOMATION_LOG_FILE || defaultLogFile);
}

function formatError(error: unknown) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  return message.replace(/\s*\n\s*/g, ' | ');
}

function write(level: 'INFO' | 'ERROR', message: string) {
  const context = logContext.getStore();
  const contextualMessage = context ? `[${context}] ${message}` : message;
  const line = `[${new Date().toISOString()}] [${level}] ${contextualMessage}`;
  const file = logFilePath();

  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${line}\n`, 'utf8');
  } catch (error) {
    // 日志写入失败不能反过来阻断自动化流程，但要在终端留下提示。
    console.error(`[日志写入失败] ${formatError(error)}`);
  }

  if (level === 'ERROR') console.error(line);
  else console.log(line);
}

export const logger = {
  withContext<T>(context: string, callback: () => Promise<T>): Promise<T> {
    return logContext.run(context, callback);
  },

  info(message: string) {
    write('INFO', message);
  },

  error(message: string, error?: unknown) {
    write('ERROR', error === undefined ? message : `${message}：${formatError(error)}`);
  },
};

export function formatDuration(startedAt: number) {
  return `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
}
