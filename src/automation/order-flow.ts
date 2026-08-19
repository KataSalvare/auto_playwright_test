import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, devices, selectors } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { fillIdentity, fillName, fillPhone } from './human-input';
import { hasValidIdentityChecksum } from './identity';
import { byTestId, getSuccessToast, LOCATORS } from './locators';
import { createMobileBrowseBehavior, isLocatorInViewport } from './mobile-browse';
import type { LocatorTestId } from './locators';
import { createSeededRandom, pick, randomBetween } from './random';
import { finalizeVideo } from './video-manager';
import type { AutomationOptions, HumanBrowseBehavior, OrderInput, RunResult } from './types';

const defaultOutputDir = resolve('output/videos');
// 自动化统一模拟 iPhone 15 的完整屏幕尺寸，不随运行环境窗口变化。
const iPhone15Screen = { width: 392, height: 852 } as const;
const sleep = (durationMs: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, durationMs));
const mark = (message: string) => console.log(`· ${message}`);
const readingOverlayTriggerMs = 2_000;
const readingWaitPollMs = 100;
const readingOverlayDismissChance = 0.35;
const firstOrderDirectPathChance = 0.8;
const firstOrderAgreementOnlyPathChance = 0.15;
const firstOrderPageBrowseMinMs = 4_000;
const firstOrderPageBrowseMaxMs = 12_000;
const agreementToPreviewDelayMs = 500;
const repeatOrderDirectPathChance = 0.8;
const repeatOrderAgreementToButtonMinMs = 1_000;
const repeatOrderAgreementToButtonMaxMs = 2_000;
const BROWSE_PROFILES = ['skimmer', 'reader', 'distracted'] as const;

type FirstOrderPreButtonPath = 'direct' | 'agreement-only' | 'full';
type RepeatOrderAgreementPath = 'direct' | 'browse-agreement';

export function chooseFirstOrderPreButtonPath(
  random: () => number,
  hasSocialSecurity: boolean,
  autoRenewal: boolean,
): FirstOrderPreButtonPath {
  // 社保和续保同时为 1 时，按 80% / 15% / 5% 模拟三类用户；其他场景固定完整浏览。
  if (!hasSocialSecurity || !autoRenewal) return 'full';

  const roll = random();
  if (roll < firstOrderDirectPathChance) return 'direct';
  if (roll < firstOrderDirectPathChance + firstOrderAgreementOnlyPathChance) {
    return 'agreement-only';
  }
  return 'full';
}

export function chooseRandomBrowseProfile(random: () => number) {
  return pick(random, BROWSE_PROFILES);
}

export function chooseRepeatOrderAgreementPath(random: () => number): RepeatOrderAgreementPath {
  return random() < repeatOrderDirectPathChance ? 'direct' : 'browse-agreement';
}

function assertBrowserLaunchAllowed() {
  if (process.platform === 'darwin' && process.env.CODEX_SANDBOX) {
    throw new Error(
      '检测到当前命令运行在 Codex macOS 沙箱中；为避免 Chrome/Chromium 原生崩溃，请在 Terminal.app 或 iTerm2 中运行：\n'
      + 'npm run automation:terminal -- --fixture=first-order',
    );
  }
}

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

async function hasInViewport(locator: Locator): Promise<boolean> {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (
      await candidate.isVisible().catch(() => false)
      && await isLocatorInViewport(candidate)
    ) {
      return true;
    }
  }
  return false;
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
  const inViewportTargets: Locator[] = [];
  for (const target of targets) {
    if (await isLocatorInViewport(target)) inViewportTargets.push(target);
  }
  const clickTargets = inViewportTargets.length > 0 ? inViewportTargets : targets;
  let lastError: unknown;

  // 页面可能同时保留多个同名节点；优先点击当前视口内、后渲染的节点，避免自动滚动到远处的 DOM 节点。
  for (const target of [...clickTargets].reverse()) {
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
    for (const target of [...clickTargets].reverse()) {
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

function startFirstOrderPageBrowse(random: () => number) {
  const durationMs = Math.round(randomBetween(
    random,
    firstOrderPageBrowseMinMs,
    firstOrderPageBrowseMaxMs,
  ));
  mark(`首单步骤 6–8：页面整体浏览 ${Math.round(durationMs / 100) / 10} 秒`);
  return { deadline: Date.now() + durationMs };
}

async function finishFirstOrderPageBrowse(
  browseSession: { deadline: number },
  step: string,
) {
  const remainingMs = browseSession.deadline - Date.now();
  if (remainingMs <= 0) return;
  mark(`${step}：继续浏览详情页 ${Math.round(remainingMs / 100) / 10} 秒`);
  await sleep(remainingMs);
}

/** 每个业务步骤完成后模拟用户观察页面的 1–2 秒停顿。 */
async function pauseAfterStep(random: () => number) {
  await waitConfigured(random, 1_000, 2_000);
}

/** 模拟用户浏览页面，直到目标控件进入可见区域。 */
async function browseUntilVisible(
  browse: HumanBrowseBehavior,
  locator: Locator,
  step: string,
  maxSwipes = 8,
  initialVisiblePause?: { minMs: number; maxMs: number } | null,
) {
  for (let swipe = 0; swipe <= maxSwipes; swipe += 1) {
    if (await hasInViewport(locator)) {
      mark(`${step}：浏览到目标位置`);
      const pauseRange = swipe === 0 ? initialVisiblePause : undefined;
      const pause = pauseRange === null ? undefined : await browse.pause(pauseRange);
      if (swipe === 0 && pauseRange && pause) {
        mark(`${step}：目标已在视口，短暂停留 ${Math.round(pause.duration / 100) / 10} 秒`);
      }
      return;
    }
    if (swipe < maxSwipes) await browse.scroll();
  }

  throw new Error(`经过 ${maxSwipes} 次浏览后${step}仍不可见`);
}

/** 步骤 7、8 点击前先滚到页面底部，并确认底部悬浮按钮已经展示。 */
async function ensureBottomFloatingButtonVisible(
  page: Page,
  browse: HumanBrowseBehavior,
  step: string,
  options: { pauseAtBottom?: boolean } = {},
) {
  await browse.scrollToBottom(options);
  const buttonLocator = byTestId(page, LOCATORS.mainButton);
  // 页面已经确认到达底部；这里仅确认按钮可见，不调用 boundingBox 或 scrollIntoViewIfNeeded，避免悬浮节点误判或页面跳动。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const visibleButtons = await visibleLocators(buttonLocator);
    if (visibleButtons.length > 0) {
      mark(`${step}：已滚动到底部，底部悬浮按钮已展示`);
      return;
    }
    if (attempt < 2) await sleep(100);
  }
  throw new Error(`${step}：页面已到达底部，但底部悬浮按钮仍未进入视口`);
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
    mark(`${flowLabel}步骤 ${agreementStep}：协议弹窗浏览等待 1–5 秒`);
    await waitWhileBrowsing(
      page,
      LOCATORS.agreementClose,
      random,
      1_000,
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
    mark(`${flowLabel}步骤 ${productStep}：产品弹窗浏览等待 1–5 秒`);
    await waitWhileBrowsing(
      page,
      LOCATORS.productClose,
      random,
      1_000,
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
   * 步骤 5 后按用户类型进入协议/社保/续保分支；9 完善信息；10 协议弹窗；
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

  if (!hasValidIdentityChecksum(order.identityNumber)) {
    throw new Error(
      '测试链接中的身份证号未通过校验位规则，页面无法进入社保步骤；请提供校验通过的测试身份证',
    );
  }

  const preButtonPath = chooseFirstOrderPreButtonPath(
    random,
    order.hasSocialSecurity,
    order.autoRenewal,
  );

  if (preButtonPath === 'direct') {
    // 方案 1：社保和续保均为 1 的大多数用户直接点击按钮，跳过步骤 6–8。
    mark('首单步骤 6–8：直接点击按钮，跳过协议、社保和续保');
    await pauseAfterStep(random);
  } else {
    const browseProfile = options.profile ?? chooseRandomBrowseProfile(random);
    mark(`首单浏览画像：${browseProfile}`);
    const browse = createMobileBrowseBehavior({
      page,
      profile: browseProfile,
      seed: options.seed + 1_001,
    });

    // 方案 2、3：先浏览页面，直到看到协议勾选位置。
    mark('首单步骤 6：浏览页面并寻找协议勾选位置');
    await browseUntilVisible(
      browse,
      byTestId(page, LOCATORS.agreementCheck),
      '协议勾选位置',
      8,
      { minMs: 1_000, maxMs: 3_000 },
    );
    mark('首单步骤 6：勾选同意协议');
    await ensureAgreementChecked(page);
    mark('首单步骤 6：协议勾选完成，等待 0.5 秒后开始预览');
    await sleep(agreementToPreviewDelayMs);

    // 协议勾选完成后，才开始步骤 7–8 的 4–12 秒整体预览预算。
    const browseSession = startFirstOrderPageBrowse(random);

    if (preButtonPath === 'full') {
      // 方案 3：继续浏览，再依次选择社保和续保。
      mark('首单步骤 7：继续浏览并寻找社保选项');
      await browseUntilVisible(
        browse,
        byTestId(page, order.hasSocialSecurity ? LOCATORS.socialSecurityYes : LOCATORS.socialSecurityNo),
        '社保选项',
      );
      await ensureBottomFloatingButtonVisible(page, browse, '首单步骤 7');
      mark('首单步骤 7：选择社保状态');
      await selectBooleanOption(
        page,
        order.hasSocialSecurity,
        LOCATORS.socialSecurityYes,
        LOCATORS.socialSecurityNo,
        '选择社保状态',
      );
      await pauseAfterStep(random);

      mark('首单步骤 8：继续浏览并寻找续保选项');
      await browseUntilVisible(
        browse,
        byTestId(page, order.autoRenewal ? LOCATORS.renewalYes : LOCATORS.renewalNo),
        '续保选项',
        8,
        null,
      );
      await ensureBottomFloatingButtonVisible(page, browse, '首单步骤 8', { pauseAtBottom: false });
      mark('首单步骤 8：选择续保状态');
      await selectBooleanOption(
        page,
        order.autoRenewal,
        LOCATORS.renewalYes,
        LOCATORS.renewalNo,
        '选择续保状态',
      );
      await pauseAfterStep(random);
    } else {
      // 方案 2：勾选协议后直接点击按钮，跳过社保和续保。
      mark('首单步骤 7–8：浏览结束，跳过社保和续保');
    }

    await finishFirstOrderPageBrowse(browseSession, '首单步骤 6–8');
  }

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

  const agreementPath = chooseRepeatOrderAgreementPath(random);
  if (agreementPath === 'direct') {
    // 大多数次单用户直接点击底部按钮，不额外浏览协议区域。
    mark('非首单步骤 2：大多数用户直接点击按钮，跳过协议浏览');
    await pauseAfterStep(random);
  } else {
    const browseProfile = options.profile ?? chooseRandomBrowseProfile(random);
    mark(`非首单浏览画像：${browseProfile}`);
    const browse = createMobileBrowseBehavior({
      page,
      profile: browseProfile,
      seed: options.seed + 2_001,
    });

    // 少数用户按真人节奏浏览到协议位置，再完成勾选。
    mark('非首单步骤 2：浏览页面并寻找协议勾选位置');
    await browseUntilVisible(
      browse,
      byTestId(page, LOCATORS.agreementCheck),
      '非首单协议勾选位置',
      8,
      { minMs: 1_000, maxMs: 3_000 },
    );
    mark('非首单步骤 2：勾选同意协议');
    await ensureAgreementChecked(page);
    mark('非首单步骤 2：协议勾选完成，随机等待 1–2 秒后点击按钮');
    await waitConfigured(
      random,
      repeatOrderAgreementToButtonMinMs,
      repeatOrderAgreementToButtonMaxMs,
    );
  }

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
  // macOS 的 Chrome/Chromium 需要访问沙箱禁止的系统服务；在浏览器启动前给出明确提示。
  assertBrowserLaunchAllowed();

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
