import { automationConfig } from '../automation.config';
import { ORDER_FIXTURES } from '../src/automation/order-links';
import { runOrderFlow } from '../src/automation/order-flow';
import { parseOrderUrl } from '../src/automation/url-config';
import type { AutomationOptions } from '../src/automation/types';

const options: AutomationOptions = {
  seed: Number(process.env.AUTOMATION_SEED ?? Date.now()),
  profile: (process.env.AUTOMATION_PROFILE as AutomationOptions['profile'] | undefined) ?? 'reader',
  product: (process.env.AUTOMATION_PRODUCT as AutomationOptions['product'] | undefined) ?? 'basic',
  waitAgreement: true,
  waitProduct: true,
  headless: process.env.HEADED === '1' ? false : automationConfig.headless,
  browserChannel: automationConfig.browserChannel,
  deleteFailedVideo: automationConfig.deleteFailedVideo,
  outputDir: automationConfig.outputDir,
};

async function main() {
  for (const [name, url] of Object.entries(ORDER_FIXTURES)) {
    const order = parseOrderUrl(url);
    console.log(`开始夹具：${name}，流程 ${order.pageOrder}`);
    await runOrderFlow(order, options);
  }

  console.log('全部测试夹具执行完成。');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
