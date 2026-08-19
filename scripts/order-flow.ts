import { resolve } from 'node:path';
import { automationConfig } from '../automation.config';
import { ORDER_FIXTURES, type OrderFixtureName } from '../src/automation/order-links';
import { runOrderFlow } from '../src/automation/order-flow';
import { parseOrderUrl, safeUrlDescription } from '../src/automation/url-config';
import type { AutomationOptions, BrowseProfile, ProductChoice } from '../src/automation/types';

/**
 * 单条订单自动化测试入口：解析参数、选择流程、启动移动端浏览器并录制视频。
 */
const profiles = new Set<BrowseProfile>(['skimmer', 'reader', 'distracted']);
const products = new Set<ProductChoice>(['basic', 'upgrade']);

function printHelp() {
  console.log(`订单自动化脚本

用法：
  npm run automation -- "<完整链接>"
  npm run automation -- --fixture=first-order
  npm run automation -- --fixture=repeat-order

选项：
  --fixture=first-order|repeat-order  使用内置测试链接
  --seed=<整数>                       固定随机行为
  --profile=reader|skimmer|distracted 移动浏览画像，默认 reader
  --product=basic|upgrade             产品选择，默认 basic
  --wait-agreement=true|false         是否等待协议蒙层，默认 true
  --wait-product=true|false           是否等待产品蒙层，默认 true
  --headed                            临时使用有头浏览器
  --headless                          临时使用无头浏览器
  --delete-failed-video=true|false    控制是否删除失败视频
  --keep-failed-video                 临时保留失败视频到 failed 目录
  --dry-run                           只解析链接，不启动浏览器
`);
}

function parseBoolean(value: string, name: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} 必须是 true 或 false`);
}

function parseArgs(argv: string[]) {
  let directUrl: string | undefined;
  let fixture: OrderFixtureName | undefined;
  let dryRun = false;
  const options: AutomationOptions = {
    seed: Date.now(),
    profile: 'reader',
    product: 'basic',
    waitAgreement: true,
    waitProduct: true,
    headless: automationConfig.headless,
    browserChannel: automationConfig.browserChannel,
    deleteFailedVideo: automationConfig.deleteFailedVideo,
    outputDir: automationConfig.outputDir,
  };

  // 命令行参数会覆盖 automation.config.ts 中的默认配置。
  for (const argument of argv) {
    if (argument === '--help' || argument === '-h') {
      printHelp();
      process.exit(0);
    }
    if (argument === '--headed') {
      options.headless = false;
      continue;
    }
    if (argument === '--headless') {
      options.headless = true;
      continue;
    }
    if (argument === '--keep-failed-video') {
      options.deleteFailedVideo = false;
      continue;
    }
    if (argument === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (!argument.startsWith('--')) {
      if (directUrl) throw new Error('只能传入一个完整业务链接');
      directUrl = argument;
      continue;
    }

    const separator = argument.indexOf('=');
    const name = separator >= 0 ? argument.slice(2, separator) : argument.slice(2);
    const value = separator >= 0 ? argument.slice(separator + 1) : undefined;

    if (name === 'fixture') {
      if (!value || !(value in ORDER_FIXTURES)) throw new Error(`未知测试夹具：${value ?? ''}`);
      fixture = value as OrderFixtureName;
    } else if (name === 'seed') {
      const seed = Number(value);
      if (!Number.isInteger(seed)) throw new Error('--seed 必须是整数');
      options.seed = seed;
    } else if (name === 'profile') {
      if (!value || !profiles.has(value as BrowseProfile)) throw new Error(`未知浏览画像：${value ?? ''}`);
      options.profile = value as BrowseProfile;
    } else if (name === 'product') {
      if (!value || !products.has(value as ProductChoice)) throw new Error(`未知产品选择：${value ?? ''}`);
      options.product = value as ProductChoice;
    } else if (name === 'wait-agreement') {
      if (!value) throw new Error('--wait-agreement 需要 true 或 false');
      options.waitAgreement = parseBoolean(value, '--wait-agreement');
    } else if (name === 'wait-product') {
      if (!value) throw new Error('--wait-product 需要 true 或 false');
      options.waitProduct = parseBoolean(value, '--wait-product');
    } else if (name === 'output-dir') {
      if (!value) throw new Error('--output-dir 不能为空');
      options.outputDir = resolve(value);
    } else if (name === 'delete-failed-video') {
      if (!value) throw new Error('--delete-failed-video 需要 true 或 false');
      options.deleteFailedVideo = parseBoolean(value, '--delete-failed-video');
    } else {
      throw new Error(`未知选项：${argument}`);
    }
  }

  const targetUrl = directUrl ?? (fixture ? ORDER_FIXTURES[fixture] : undefined);
  if (!targetUrl) throw new Error('请传入完整业务链接或 --fixture=first-order|repeat-order');
  return { targetUrl, options, dryRun, fixture };
}

async function main() {
  // dry-run 只校验链接参数，不会启动浏览器。
  const { targetUrl, options, dryRun, fixture } = parseArgs(process.argv.slice(2));
  const order = parseOrderUrl(targetUrl);

  console.log(`订单 ${order.orderId}：${fixture ?? 'custom-url'}，流程 ${order.pageOrder}`);
  console.log(`页面：${safeUrlDescription(targetUrl)}`);

  if (dryRun) {
    console.log('参数校验通过，未启动浏览器。');
    return;
  }

  const result = await runOrderFlow(order, options);
  console.log(`流程成功，视频：${result.videoPath ?? '未生成'}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
