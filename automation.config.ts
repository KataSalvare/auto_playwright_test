import { resolve } from 'node:path';
import type { AutomationConfig } from './src/automation/types';

/**
 * 订单自动化调试配置。
 *
 * 直接修改这里的布尔值即可影响 npm run automation 的默认行为。
 * 命令行参数 --headed、--headless、--delete-failed-video 和
 * --keep-failed-video 可以临时覆盖本文件配置。
 */
export const automationConfig = {
  // false：显示浏览器，便于观察页面；true：后台运行。
  headless: true,

  // false：失败视频移动到 output/playwright/videos/failed/，便于排查。
  deleteFailedVideo: true,

  outputDir: resolve('output/playwright/videos'),
} satisfies AutomationConfig;
