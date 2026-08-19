import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, devices, selectors } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { fillIdentity, fillName, fillPhone } from './human-input';
import { hasValidIdentityChecksum } from './identity';
import { byTestId, getSuccessToast, LOCATORS } from './locators';
import type { LocatorTestId } from './locators';
import { createSeededRandom, randomBetween } from './random';
import { finalizeVideo } from './video-manager';
import type { AutomationOptions, OrderInput, RunResult } from './types';

const defaultOutputDir = resolve('output/videos');
// 自动化统一模拟 iPhone 15 的完整屏幕尺寸，不随运行环境窗口变化。
const iPhone15Screen = { width: 392, height: 852 } as const;
const sleep = (durationMs: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, durationMs));
const mark = (message: string) => console.log(`· ${message}`);
const readingOverlayTriggerMs = 2_000;
const readingWaitPollMs = 100;
const readingOverlayDismissChance = 0.35;

/** 在多个同名元素中返回当前真正可见的元素。 */
async function visibleLocator(locator: Locator, step: string): Promise<Locator> {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  throw new Error(`步骤“${step}”未找到可见元素`);
}

async function visibleLocators(locator: Locator): Promise<Locator[]> {
  const visible: Locator[] = [];
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) visible.push(candidate);
  }
  return visible;
}

async function hasVisible(locator: Locator): Promise<boolean> {
  return (await visibleLocators(locator)).length > 0;
}

async function readingOverlayIsVisible(page: Page, closeTestId?: LocatorTestId): Promise<boolean> {
  const closeVisible = closeTestId
    ? await hasVisible(byTestId(page, closeTestId))
    : false;
  // 真实页面的等待蒙层使用 class="mask"，不一定带 close test id。
  return closeVisible || await hasVisible(page.locator('.mask'));
}

async function clickTestId(
  page: Page,
  testId: LocatorTestId,
  step: string,
  options: { overlayClose?: LocatorTestId } = {},
) {
  const targetLocator = byTestId(page, testId);
  await waitForAnyVisible(targetLocator, 10_000, step);
  const targets = await visibleLocators(targetLocator);
  let lastError: unknown;

  // 页面可能同时保留底层按钮和蒙层内按钮，优先尝试后渲染的按钮。
  for (const target of [...targets].reverse()) {
    try {
      await target.click({ timeout: 5_000 });
      return;
    } catch (error) {
      lastError = error;
    }
  }

  // 阅读等待期间的蒙层不应让按钮点击失败；全部普通点击失败后再走 force。
  if (await readingOverlayIsVisible(page, options.overlayClose)) {
    mark(`${step}：蒙层仍在显示，继续触发按钮点击`);
    for (const target of [...targets].reverse()) {
      try {
        await target.click({ timeout: 5_000, force: true });
        return;
      } catch (error) {
        lastError = error;
      }
    }
  }

  // 主按钮可能刚触发弹窗，弹窗遮挡会让 Playwright 报点击被拦截；
  // 只要目标弹窗已经出现，就视为主按钮点击已生效。
  const mainButtonTriggeredPopup = testId === LOCATORS.mainButton && (
    await byTestId(page, LOCATORS.phoneContinue).isVisible().catch(() => false)
    || await byTestId(page, LOCATORS.agreementContinue).isVisible().catch(() => false)
  );
  if (mainButtonTriggeredPopup) return;
  throw lastError;
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

/**
 * 模拟用户在协议/产品弹窗中浏览一段时间。
 *
 * 页面在等待约 2 秒后可能展示蒙层。这里只观察它，不把蒙层视为失败；
 * 用户也可能已经手动关闭蒙层，后续仍应继续点击业务按钮。
 */
async function waitWhileBrowsing(
  page: Page,
  overlayClose: LocatorTestId,
  random: () => number,
  minMs: number,
  maxMs: number,
  step: string,
) {
  const durationMs = Math.round(randomBetween(random, minMs, maxMs));
  const startedAt = Date.now();
  let overlayDetected = false;
  let overlayDismissed = false;

  while (Date.now() - startedAt < durationMs) {
    const elapsedMs = Date.now() - startedAt;
    if (!overlayDetected && elapsedMs >= readingOverlayTriggerMs) {
      overlayDetected = await readingOverlayIsVisible(page, overlayClose);
      if (overlayDetected) {
        mark(`${step}：浏览等待超过 ${readingOverlayTriggerMs / 1_000} 秒，检测到蒙层`);
        // 模拟一部分用户会主动关闭蒙层，再继续浏览一会儿。
        if (random() < readingOverlayDismissChance) {
          const close = byTestId(page, overlayClose);
          try {
            await close.click({ timeout: 1_500 });
            overlayDismissed = true;
            mark(`${step}：用户关闭蒙层，继续浏览后再点击按钮`);
            await pauseAfterStep(random);
          } catch {
            // 蒙层可能已被页面或用户关闭；后续按钮点击仍按容错路径处理。
          }
        }
      }
    }

    const remainingMs = durationMs - (Date.now() - startedAt);
    await sleep(Math.min(readingWaitPollMs, Math.max(remainingMs, 0)));
  }

  if (overlayDetected && !overlayDismissed) {
    mark(`${step}：蒙层不阻断后续按钮点击，继续完成浏览等待`);
  }
}

async function waitConfigured(random: () => number, minMs: number, maxMs: number) {
  await sleep(Math.round(randomBetween(random, minMs, maxMs)));
}

/** 每个业务步骤完成后模拟用户观察页面的 1–2 秒停顿。 */
async function pauseAfterStep(random: () => number) {
  await waitConfigured(random, 1_000, 2_000);
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
  await clickTestId(
    page,
    testId,
    product === 'basic' ? '选择基础版' : '选择升级版',
    { overlayClose: LOCATORS.productClose },
  );
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
  flowLabel: string,
  agreementStep: number,
  productStep: number,
  markRecordingCutoff: () => void,
) {
  // 主按钮已经触发协议弹窗，模拟用户阅读/浏览后再继续。
  if (options.waitAgreement) {
    mark(`${flowLabel}步骤 ${agreementStep}：协议弹窗浏览等待 2–5 秒`);
    await waitWhileBrowsing(
      page,
      LOCATORS.agreementClose,
      random,
      2_000,
      5_000,
      `${flowLabel}步骤 ${agreementStep}`,
    );
  }
  mark(`${flowLabel}步骤 ${agreementStep}：点击强制阅读协议弹窗同意并继续`);
  await clickTestId(
    page,
    LOCATORS.agreementContinue,
    '协议同意并继续',
    { overlayClose: LOCATORS.agreementClose },
  );
  await pauseAfterStep(random);

  // 协议确认已经触发产品弹窗，模拟用户查看/浏览产品后再选择。
  if (options.waitProduct) {
    mark(`${flowLabel}步骤 ${productStep}：产品弹窗浏览等待 2–5 秒`);
    await waitWhileBrowsing(
      page,
      LOCATORS.productClose,
      random,
      2_000,
      5_000,
      `${flowLabel}步骤 ${productStep}`,
    );
  }
  mark(`${flowLabel}步骤 ${productStep}：选择${options.product === 'basic' ? '基础版' : '升级版'}产品`);
  await selectProduct(page, options.product);

  // 原生 Video 不能在页面继续运行时单独停止，因此记录裁剪点，页面继续监控 success。
  mark(`${flowLabel}步骤 ${productStep}：等待 2–3 秒并记录裁剪点`);
  await waitConfigured(random, 2_000, 3_000);
  mark(`${flowLabel}步骤 ${productStep}：记录视频裁剪点`);
  markRecordingCutoff();
}

async function runFirstOrder(
  page: Page,
  order: OrderInput,
  options: AutomationOptions,
  random: () => number,
  markRecordingCutoff: () => void,
) {
  /*
   * 首单步骤：
   * 1 手机号；2 处理手机号弹窗；3 等待页面切换；4 姓名；5 身份证；
   * 6 社保；7 续保；8 协议勾选；9 完善信息；10 协议弹窗；
  * 11 产品；12 成功 Toast。
  */
  // 步骤 1 前：页面打开后先随机等待，暂不执行滚动等浏览操作。
  mark('首单步骤 1 前：随机等待 2–5 秒');
  await waitConfigured(random, 2_000, 5_000); 
  // 步骤 1：输入手机号。
  mark('首单步骤 1：输入手机号');
  await fillPhone({
    page,
    value: order.phone,
    seed: options.seed,
    inputStrategy: options.inputStrategy,
    errorChance: options.phoneErrorChance,
  });
  await pauseAfterStep(random);
  // 步骤 2：如果出现手机号确认弹窗，点击“同意并继续”。
  mark('首单步骤 2：处理手机号确认弹窗');
  await clickIfAppears(page, LOCATORS.phoneContinue);
  await pauseAfterStep(random);

  // 步骤 3：等待页面切换到实名信息区域。
  mark('首单步骤 3：等待页面进入实名信息');
  await waitConfigured(random, 2_000, 3_000);
  await pauseAfterStep(random);

  // 步骤 4：输入姓名。
  mark('首单步骤 4：输入姓名');
  await fillName({
    page,
    value: order.name,
    seed: options.seed,
    inputStrategy: options.inputStrategy,
  });
  await pauseAfterStep(random);

  // 步骤 5：通过自定义身份证键盘输入身份证。
  mark('首单步骤 5：输入身份证');
  await fillIdentity({
    page,
    value: order.identityNumber,
    seed: options.seed,
    inputStrategy: options.inputStrategy,
    errorChance: options.identityErrorChance,
    missingChance: options.identityMissingChance,
  });
  await pauseAfterStep(random);

  if (!hasValidIdentityChecksum(order.identityNumber)) {
    throw new Error(
      '测试链接中的身份证号未通过校验位规则，页面无法进入社保步骤；请提供校验通过的测试身份证',
    );
  }

  // 步骤 6：选择社保状态（浏览节点暂不执行，等待后续补充）。
  mark('首单步骤 6：选择社保状态');
  await selectBooleanOption(
    page,
    order.hasSocialSecurity,
    LOCATORS.socialSecurityYes,
    LOCATORS.socialSecurityNo,
    '选择社保状态',
  );
  await pauseAfterStep(random);

  // 步骤 7：选择是否自动续保。
  mark('首单步骤 7：选择续保状态');
  await selectBooleanOption(
    page,
    order.autoRenewal,
    LOCATORS.renewalYes,
    LOCATORS.renewalNo,
    '选择续保状态',
  );
  await pauseAfterStep(random);

  // 步骤 8：勾选协议。
  mark('首单步骤 8：勾选同意协议');
  await ensureAgreementChecked(page);
  await pauseAfterStep(random);

  // 步骤 9：点击“点此登录/完善信息”进入保障流程。
  mark('首单步骤 9：点击完善信息');
  await clickTestId(page, LOCATORS.mainButton, '点击完善信息');
  await pauseAfterStep(random);

  // 步骤 10、11：处理协议弹窗并选择产品。
  await runAgreementAndProductFlow(page, options, random, '首单', 10, 11, markRecordingCutoff);
}

async function runRepeatOrder(
  page: Page,
  options: AutomationOptions,
  random: () => number,
  markRecordingCutoff: () => void,
) {
  /* 非首单步骤：1 等待页面；2 勾选协议；3 完善信息；4 协议弹窗；5 产品；6 成功 Toast。 */
  // 步骤 1 前：页面打开后先随机等待，暂不执行滚动等浏览操作。
  mark('非首单步骤 1 前：随机等待 6–9 秒');
  await waitConfigured(random, 6_000, 9_000);
  // 步骤 1：页面稳定后继续处理已有实名信息。
  mark('非首单步骤 1：页面稳定');
  await pauseAfterStep(random);

  // 步骤 2：确保协议处于勾选状态。
  mark('非首单步骤 2：勾选同意协议');
  await ensureAgreementChecked(page);
  await pauseAfterStep(random);

  // 步骤 3：点击“完善信息”进入保障流程。
  mark('非首单步骤 3：点击完善信息');
  await clickTestId(page, LOCATORS.mainButton, '点击完善信息');
  await pauseAfterStep(random);

  // 步骤 4、5：处理协议弹窗并选择产品。
  await runAgreementAndProductFlow(page, options, random, '非首单', 4, 5, markRecordingCutoff);
}

export async function runOrderFlow(
  order: OrderInput,
  options: AutomationOptions,
): Promise<RunResult> {
  // 每个订单使用独立浏览器上下文；原生录像在 context 关闭时完成写入。
  const outputDir = options.outputDir || defaultOutputDir;
  const pendingDir = resolve(outputDir, '.pending');
  await mkdir(pendingDir, { recursive: true });

  selectors.setTestIdAttribute('jing-testid');

  const browser = await chromium.launch({
    headless: options.headless,
    channel: process.env.PW_CHANNEL || options.browserChannel,
  });
  const context = await browser.newContext({
    ...devices['iPhone 15'],
    viewport: iPhone15Screen,
    screen: iPhone15Screen,
    recordVideo: {
      dir: pendingDir,
      size: iPhone15Screen,
    },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'light',
  });
  const page = await context.newPage();
  const nativeVideo = page.video();
  const recordingStartedAt = Date.now();
  let recordedPath: string | undefined;
  let recordingCutoffAt: number | undefined;
  const markRecordingCutoff = () => {
    if (!recordingCutoffAt) recordingCutoffAt = Date.now();
  };
  const random = createSeededRandom(options.seed + 101);
  let success = false;
  let failure: unknown;

  try {
    mark(`打开页面：流程 ${order.pageOrder}`);
    await page.goto(order.sourceUrl, { waitUntil: 'domcontentloaded' });
    if (order.pageOrder === 1) await runFirstOrder(page, order, options, random, markRecordingCutoff);
    else await runRepeatOrder(page, options, random, markRecordingCutoff);

    const flowLabel = order.pageOrder === 1 ? '首单' : '非首单';
    const successStep = order.pageOrder === 1 ? 12 : 6;
    // 最后一步：success Toast 是订单流程的唯一成功判定。
    mark(`${flowLabel}步骤 ${successStep}：等待成功 Toast`);
    await waitForAnyVisible(getSuccessToast(page), 30_000, '成功 Toast');
    success = true;
    mark(`${flowLabel}步骤 ${successStep}：检测到成功 Toast`);
  } catch (error) {
    failure = error;
  } finally {
    try {
      // 原生 Video 只有在 context 关闭后才保证已写入磁盘。
      await context.close();
      if (nativeVideo) recordedPath = await nativeVideo.path();
    } catch (error) {
      if (!failure) failure = error;
    }
    await browser.close();
  }

  const videoPath = await finalizeVideo({
    recordedPath,
    success,
    orderId: order.orderId,
    outputDir,
    deleteFailedVideo: options.deleteFailedVideo,
    trimDurationMs: recordingCutoffAt ? recordingCutoffAt - recordingStartedAt : undefined,
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
