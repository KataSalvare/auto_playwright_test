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

  // 使用本机 Chrome，避免重复下载浏览器；删除此项可改用 Playwright Chromium。
  browserChannel: 'chrome',

  // true：失败视频移动到 output/videos/failed/；false：未出现 success 时删除视频。
  deleteFailedVideo: false,

  outputDir: resolve('output/videos'),
} satisfies AutomationConfig;
