import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, devices, selectors } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { fillIdentity, fillName, fillPhone } from './human-input';
import { byTestId, LOCATORS } from './locators';
import type { LocatorTestId } from './locators';
import { createMobileBrowseBehavior } from './mobile-browse';
import { createSeededRandom, randomBetween } from './random';
import { finalizeVideo } from './video-manager';
import type { AutomationOptions, OrderInput, RunResult } from './types';

const defaultOutputDir = resolve('output/playwright/videos');
const sleep = (durationMs: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, durationMs));
const mark = (message: string) => console.log(`· ${message}`);

async function visibleLocator(locator: Locator, step: string): Promise<Locator> {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  throw new Error(`步骤“${step}”未找到可见元素`);
}

async function clickTestId(page: Page, testId: LocatorTestId, step: string) {
  const target = await waitForAnyVisible(byTestId(page, testId), 10_000, step);
  try {
    await target.click({ timeout: 5_000 });
  } catch (error) {
    const mainButtonTriggeredPopup = testId === LOCATORS.mainButton && (
      await byTestId(page, LOCATORS.phoneContinue).isVisible().catch(() => false)
      || await byTestId(page, LOCATORS.agreementContinue).isVisible().catch(() => false)
    );
    if (!mainButtonTriggeredPopup) throw error;
  }
}

async function clickIfAppears(page: Page, testId: LocatorTestId, timeoutMs = 5_000) {
  try {
    const target = await waitForAnyVisible(byTestId(page, testId), timeoutMs, testId);
    await target.click({ timeout: 5_000 });
  } catch {
    // 某些测试环境不会出现手机号确认弹窗，此时按页面当前状态继续。
  }
}

async function waitForAnyVisible(locator: Locator, timeoutMs: number, step = '目标元素'): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = await locator.count();
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
    await sleep(100);
  }
  throw new Error(`在 ${timeoutMs}ms 内未找到${step}`);
}

async function failIfClosed(page: Page, testId: LocatorTestId, step: string) {
  const close = byTestId(page, testId);
  if (await close.isVisible().catch(() => false)) {
    throw new Error(`步骤“${step}”检测到用户关闭弹窗`);
  }
}

async function waitConfigured(random: () => number, minMs: number, maxMs: number) {
  await sleep(Math.round(randomBetween(random, minMs, maxMs)));
}

async function ensureAgreementChecked(page: Page) {
  const checkbox = await visibleLocator(
    byTestId(page, LOCATORS.agreementCheck),
    '勾选同意协议',
  );
  const checked = await checkbox.isChecked().catch(() => false);
  if (!checked) await checkbox.click();
}

async function selectProduct(page: Page, product: AutomationOptions['product']) {
  const testId = product === 'basic' ? LOCATORS.basicProduct : LOCATORS.upgradeProduct;
  await clickTestId(page, testId, product === 'basic' ? '选择基础版' : '选择升级版');
}

async function selectBooleanOption(
  page: Page,
  enabled: boolean,
  yesId: LocatorTestId,
  noId: LocatorTestId,
  step: string,
) {
  await clickTestId(page, enabled ? yesId : noId, step);
}

async function runAgreementAndProductFlow(
  page: Page,
  options: AutomationOptions,
  random: () => number,
) {
  await failIfClosed(page, LOCATORS.agreementClose, '强制阅读协议');
  if (options.waitAgreement) await waitConfigured(random, 2_000, 2_000);
  await clickTestId(page, LOCATORS.agreementContinue, '协议同意并继续');

  await failIfClosed(page, LOCATORS.productClose, '选择产品');
  if (options.waitProduct) await waitConfigured(random, 2_000, 2_000);
  await selectProduct(page, options.product);
}

async function runFirstOrder(
  page: Page,
  order: OrderInput,
  options: AutomationOptions,
  random: () => number,
) {
  mark('首单：输入手机号');
  await fillPhone({
    page,
    value: order.phone,
    seed: options.seed,
    errorChance: options.phoneErrorChance,
  });
  mark('首单：点击登录并处理手机号弹窗');
  await clickTestId(page, LOCATORS.mainButton, '点击点此登录');
  await clickIfAppears(page, LOCATORS.phoneContinue);
  await waitConfigured(random, 2_000, 3_000);

  mark('首单：输入姓名和身份证');
  await fillName({ page, value: order.name, seed: options.seed });
  await fillIdentity({
    page,
    value: order.identityNumber,
    seed: options.seed,
    errorChance: options.identityErrorChance,
    missingChance: options.identityMissingChance,
  });

  const browse = createMobileBrowseBehavior({ page, profile: options.profile, seed: options.seed });
  mark('首单：模拟浏览并选择社保、续保');
  await browse.scroll();
  await selectBooleanOption(
    page,
    order.hasSocialSecurity,
    LOCATORS.socialSecurityYes,
    LOCATORS.socialSecurityNo,
    '选择社保状态',
  );
  await selectBooleanOption(
    page,
    order.autoRenewal,
    LOCATORS.renewalYes,
    LOCATORS.renewalNo,
    '选择续保状态',
  );

  mark('首单：勾选协议并进入投保流程');
  await ensureAgreementChecked(page);
  await clickTestId(page, LOCATORS.mainButton, '点击完善信息');
  mark('首单：处理协议和产品弹窗');
  await runAgreementAndProductFlow(page, options, random);
  await browse.pause({ minMs: 500, maxMs: 2_000 });
}

async function runRepeatOrder(
  page: Page,
  options: AutomationOptions,
  random: () => number,
) {
  const browse = createMobileBrowseBehavior({ page, profile: options.profile, seed: options.seed });
  mark('非首单：等待并进入投保流程');
  await browse.pause({ minMs: 2_000, maxMs: 3_000 });
  await ensureAgreementChecked(page);
  await clickTestId(page, LOCATORS.mainButton, '点击完善信息');
  mark('非首单：处理协议和产品弹窗');
  await runAgreementAndProductFlow(page, options, random);
  await browse.pause({ minMs: 500, maxMs: 2_000 });
}

export async function runOrderFlow(
  order: OrderInput,
  options: AutomationOptions,
): Promise<RunResult> {
  const outputDir = options.outputDir || defaultOutputDir;
  const pendingDir = resolve(outputDir, '.pending');
  await mkdir(pendingDir, { recursive: true });

  selectors.setTestIdAttribute('jing-testid');

  const browser = await chromium.launch({
    headless: options.headless,
    channel: process.env.PW_CHANNEL || undefined,
  });
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'light',
    recordVideo: {
      dir: pendingDir,
      size: { width: 390, height: 844 },
    },
  });
  const page = await context.newPage();
  const video = page.video();
  const random = createSeededRandom(options.seed + 101);
  let success = false;
  let failure: unknown;

  try {
    mark(`打开页面：流程 ${order.pageOrder}`);
    await page.goto(order.sourceUrl, { waitUntil: 'domcontentloaded' });
    if (order.pageOrder === 1) await runFirstOrder(page, order, options, random);
    else await runRepeatOrder(page, options, random);

    mark('等待成功 Toast');
    await waitForAnyVisible(byTestId(page, LOCATORS.successToast), 30_000, '成功 Toast');
    success = true;
  } catch (error) {
    failure = error;
  } finally {
    await context.close();
    await browser.close();
  }

  const videoPath = await finalizeVideo({
    video,
    success,
    orderId: order.orderId,
    outputDir,
    deleteFailedVideo: options.deleteFailedVideo,
  });

  if (!success) {
    const message = failure instanceof Error ? failure.message : String(failure);
    const videoHint = videoPath ? `\n失败视频：${videoPath}` : '';
    throw new Error(`${message}${videoHint}`, { cause: failure });
  }

  return {
    orderId: order.orderId,
    pageOrder: order.pageOrder,
    success,
    videoPath,
  };
}
