import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, devices, selectors } from '@playwright/test';
import type { Browser, BrowserContext, Frame, Locator, Page } from '@playwright/test';
import { fillIdentity, fillName, fillPhone } from './human-input';
import { hasValidIdentityChecksum } from './identity';
import { byTestId, getSuccessToast, LOCATORS } from './locators';
import { createMobileBrowseBehavior, isLocatorInViewport } from './mobile-browse';
import type { LocatorTestId } from './locators';
import { createSeededRandom, pick, randomBetween, randomInteger } from './random';
import { finalizeVideo } from './video-manager';
import type { AutomationOptions, HumanBrowseBehavior, OrderInput, RunResult } from './types';
import { formatDuration, logger } from './logger';

const defaultOutputDir = resolve('output/videos');
// 自动化统一模拟 iPhone 15 的完整屏幕尺寸，不随运行环境窗口变化。
const iPhone15Screen = { width: 392, height: 852 } as const;
const sleep = (durationMs: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, durationMs));
const mark = (message: string) => logger.info(`· ${message}`);
const readingOverlayTriggerMs = 2_000;
const readingWaitPollMs = 100;
const readingOverlayDismissChance = 0.9;
const readingOverlayReactionMinMs = 500;
const readingOverlayReactionMaxMs = 2_000;
const readingOverlayAfterDismissMinMs = 500;
const readingOverlayAfterDismissMaxMs = 1_000;
const readingPopupInitialBrowseMinMs = 500;
const readingPopupInitialBrowseMaxMs = 1_500;
const agreementPopupBrowseChance = 0.4;
const agreementAfterOverlayDirectChance = 0.25;
const agreementAfterOverlayContinueChance = 0.25;
const agreementBrowseAfterTabSwitchChance = 0.8;
const agreementPostOverlayBrowseMinMs = 2_000;
const agreementPostOverlayBrowseMaxMs = 5_000;
const agreementSecondaryOverlayMaxOccurrences = 3;
const firstOrderDirectPathChance = 0.8;
const firstOrderAgreementOnlyPathChance = 0.15;
const firstOrderPageBrowseMinMs = 4_000;
const firstOrderPageBrowseMaxMs = 12_000;
const agreementToButtonDelayMs = 1_000;
const repeatOrderDirectPathChance = 0.8;
const repeatOrderAgreementToButtonMinMs = 1_000;
const repeatOrderAgreementToButtonMaxMs = 2_000;
const BROWSE_PROFILES = ['skimmer', 'reader', 'distracted'] as const;

type FirstOrderPreButtonPath = 'direct' | 'agreement-only' | 'full';
type RepeatOrderAgreementPath = 'direct' | 'browse-agreement';
type AgreementAfterOverlayBehavior = 'direct' | 'continue-current' | 'switch-tabs';
type AgreementTabBrowseTotal = 2 | 3 | 4;

type PopupBox = { x: number; y: number; width: number; height: number };

type PopupScrollBox = PopupBox & {
  tagName: string;
  className: string;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

type PopupScrollCandidate = {
  tagName: string;
  className: string;
  scrollRange: number;
  containsAction: boolean;
};

type PopupTab = PopupBox & {
  label: string;
  active: boolean;
};

type AgreementPopupUi = {
  scrollBox: PopupScrollBox | null;
  gestureBox: PopupBox | null;
  contentSignature: string;
  tabs: PopupTab[];
  scrollCandidates: PopupScrollCandidate[];
};

type InterruptibleAgreementBrowseOptions = {
  durationMs: number;
  maxOverlayOccurrences: number;
  now: () => number;
  browseOnce: () => Promise<boolean>;
  isOverlayVisible: () => Promise<boolean>;
  dismissOverlay: () => Promise<boolean>;
  wait: (durationMs: number) => Promise<unknown>;
  nextPauseMs: () => number;
};

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

export function chooseAgreementPopupBrowse(random: () => number): boolean {
  return random() < agreementPopupBrowseChance;
}

export function chooseAgreementAfterOverlayBehavior(
  random: () => number,
): AgreementAfterOverlayBehavior {
  const roll = random();
  if (roll < agreementAfterOverlayDirectChance) return 'direct';
  if (roll < agreementAfterOverlayDirectChance + agreementAfterOverlayContinueChance) {
    return 'continue-current';
  }
  return 'switch-tabs';
}

export function chooseAgreementBrowseAfterTabSwitch(random: () => number): boolean {
  return random() < agreementBrowseAfterTabSwitchChance;
}

/**
 * 选择包含初始 TAB 在内的总浏览数：2 / 3 / 4 = 62.5% / 25% / 12.5%。
 * 结合关闭蒙层后的三类行为，整体约为 1 / 2 / 3 / 4 个 TAB = 60% / 25% / 10% / 5%。
 */
export function chooseAgreementTabBrowseTotal(random: () => number): AgreementTabBrowseTotal {
  const roll = random();
  if (roll < 0.625) return 2;
  if (roll < 0.875) return 3;
  return 4;
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

async function readingMaskIsVisible(page: Page): Promise<boolean> {
  return hasVisible(page.locator('.mask'));
}

async function readingOverlayIsVisible(page: Page, closeTestId?: LocatorTestId): Promise<boolean> {
  const closeVisible = closeTestId
    ? await hasVisible(byTestId(page, closeTestId))
    : false;
  // 真实页面的等待蒙层使用 class="mask"，不一定带 close test id。
  return closeVisible || await readingMaskIsVisible(page);
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

async function waitForPhoneConfirmationHandled(page: Page, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  const continueLocator = byTestId(page, LOCATORS.phoneContinue);
  const nameInputLocator = byTestId(page, LOCATORS.nameInput);

  while (Date.now() < deadline) {
    // 点击完成后，弹窗应消失；如果页面已经切换到姓名输入，也视为处理成功。
    if (!(await hasVisible(continueLocator)) || await hasVisible(nameInputLocator)) return;
    await sleep(100);
  }

  throw new Error('手机号确认弹窗点击后仍未关闭');
}

/**
 * 可选弹窗点击：弹窗没有出现时继续；弹窗一旦出现，点击失败必须重试并报错。
 * 手机号确认弹窗出现时通常伴随键盘收起动画，因此不能只做一次普通 click。
 */
async function clickIfAppears(page: Page, testId: LocatorTestId, timeoutMs = 10_000) {
  try {
    await waitForAnyVisible(byTestId(page, testId), timeoutMs, testId);
  } catch {
    // 某些测试环境不会出现手机号确认弹窗，此时按页面当前状态继续。
    return;
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      // 复用统一点击逻辑：处理多个同名节点、视口、蒙层和 force fallback。
      await clickTestId(page, testId, '手机号确认弹窗同意并继续');
      await waitForPhoneConfirmationHandled(page);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        mark(`手机号确认弹窗点击第 ${attempt} 次未完成，准备重试`);
        await sleep(300);
      }
    }
  }

  throw new Error(
    `手机号确认弹窗点击失败（已重试 3 次）：${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

async function dismissReadingOverlay(
  page: Page,
  closeTestId: LocatorTestId,
  step: string,
) {
  const maskTargets = await visibleLocators(page.locator('.mask'));
  const closeLocators = [
    byTestId(page, closeTestId),
    // 真实页面的协议/产品弹窗关闭按钮使用 Vant 的 class，没有 jing-testid。
    page.locator('.van-popup__close-icon'),
    page.locator('[class*="van-popup__close"]'),
  ];
  const closeTargets: Locator[] = [];
  for (const locator of closeLocators) {
    closeTargets.push(...await visibleLocators(locator));
  }
  // 阅读提示蒙层本身是可点击关闭的；必须优先处理它，不能误点弹窗右上角 X。
  const visibleTargets = [...maskTargets.reverse(), ...closeTargets.reverse()];
  if (visibleTargets.length === 0) {
    mark(`${step}：未找到可见的蒙层关闭按钮`);
    return false;
  }

  let lastError: unknown;
  for (const target of visibleTargets) {
    try {
      await target.click({ timeout: 500 });
      if (!await hasVisible(page.locator('.mask'))) return true;
    } catch (error) {
      lastError = error;
    }
  }

  // 蒙层可能正处于动画或遮挡按钮；当前按钮已确认可见时允许 force click。
  for (const target of visibleTargets) {
    try {
      await target.click({ timeout: 500, force: true });
      if (!await hasVisible(page.locator('.mask'))) return true;
    } catch (error) {
      lastError = error;
    }
  }

  mark(`${step}：关闭蒙层失败，${lastError instanceof Error ? lastError.message : String(lastError)}`);
  return false;
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
  hooks: {
    onBrowse?: () => Promise<boolean>;
    onOverlayDismiss?: () => Promise<{
      browseConfirmed?: boolean;
      finishBrowsing?: boolean;
    }>;
  } = {},
) {
  const durationMs = Math.round(randomBetween(random, minMs, maxMs));
  const startedAt = Date.now();
  let overlayDetected = false;
  let overlayDismissed = false;
  let browseConfirmed = false;
  const initialBrowseDelay = hooks.onBrowse
    ? Math.round(randomBetween(random, readingPopupInitialBrowseMinMs, readingPopupInitialBrowseMaxMs))
    : 0;
  if (initialBrowseDelay > 0) {
    mark(`${step}：协议弹窗出现后先停留 ${Math.round(initialBrowseDelay / 10) / 100} 秒`);
  }
  let nextBrowseAt = startedAt + initialBrowseDelay;
  let overlayObservationDeadline = startedAt + durationMs;

  while (
    Date.now() - startedAt < durationMs
    || Boolean(
      hooks.onOverlayDismiss
      && browseConfirmed
      && !overlayDetected
      && Date.now() < overlayObservationDeadline
    )
  ) {
    const elapsedMs = Date.now() - startedAt;

    const maskAlreadyVisible = elapsedMs >= readingOverlayTriggerMs
      && await readingMaskIsVisible(page);
    if (
      hooks.onBrowse
      && !overlayDetected
      && !maskAlreadyVisible
      && elapsedMs < durationMs
      && Date.now() >= nextBrowseAt
    ) {
      browseConfirmed = (await hooks.onBrowse()) || browseConfirmed;
      nextBrowseAt = Date.now() + Math.round(randomBetween(random, 700, 1_400));
      // 一次真人滚动本身可能超过原浏览预算；给蒙层动画留出短暂观察窗口。
      overlayObservationDeadline = Math.max(overlayObservationDeadline, Date.now() + 800);
    }

    if (!overlayDetected && elapsedMs >= readingOverlayTriggerMs) {
      overlayDetected = await readingOverlayIsVisible(page, overlayClose);
      if (overlayDetected) {
        mark(`${step}：浏览等待超过 ${readingOverlayTriggerMs / 1_000} 秒，检测到蒙层`);
        // 模拟大多数用户发现蒙层后主动关闭，再继续浏览一会儿。
        if (random() < readingOverlayDismissChance) {
          try {
            await waitConfigured(random, readingOverlayReactionMinMs, readingOverlayReactionMaxMs);
            const dismissed = await dismissReadingOverlay(page, overlayClose, step);
            if (dismissed) {
              overlayDismissed = true;
              mark(`${step}：用户快速关闭蒙层`);
              await waitConfigured(
                random,
                readingOverlayAfterDismissMinMs,
                readingOverlayAfterDismissMaxMs,
              );
              if (hooks.onOverlayDismiss) {
                const result = await hooks.onOverlayDismiss();
                browseConfirmed = Boolean(result.browseConfirmed) || browseConfirmed;
                if (result.finishBrowsing) return { browseConfirmed };
              }
            }
          } catch {
            // 蒙层可能已被页面或用户关闭；后续按钮点击仍按容错路径处理。
          }
        }
      }
    }

    const remainingMs = durationMs - (Date.now() - startedAt);
    await sleep(remainingMs > 0
      ? Math.min(readingWaitPollMs, remainingMs)
      : readingWaitPollMs);
  }

  if (overlayDetected && !overlayDismissed) {
    mark(`${step}：蒙层不阻断后续按钮点击，继续完成浏览等待`);
  }

  return { browseConfirmed };
}

/**
 * 读取协议弹窗内的可滚动区域和 TAB。
 *
 * 协议弹窗的业务页面没有统一暴露 TAB/内容容器 test id，因此从协议确认按钮
 * 和关闭按钮的共同祖先开始探测，兼容 role、class 和 test id 等常见写法。
 */
async function getAgreementPopupUi(page: Page): Promise<AgreementPopupUi> {
  return page.evaluate(({ agreementContinue, agreementClose }) => {
    const continueElement = document.querySelector(`[jing-testid="${agreementContinue}"]`);
    const closeElement = document.querySelector(`[jing-testid="${agreementClose}"]`);
    if (!continueElement) {
      return {
        scrollBox: null,
        gestureBox: null,
        contentSignature: '',
        tabs: [],
        scrollCandidates: [],
      };
    }

    const continueHtmlElement = continueElement as HTMLElement;
    const continueRect = continueHtmlElement.getBoundingClientRect();
    const continueStyle = window.getComputedStyle(continueHtmlElement);
    if (
      continueRect.width <= 0
      || continueRect.height <= 0
      || continueStyle.display === 'none'
      || continueStyle.visibility === 'hidden'
    ) {
      return {
        scrollBox: null,
        gestureBox: null,
        contentSignature: '',
        tabs: [],
        scrollCandidates: [],
      };
    }

    let popupRoot: Element = continueElement;
    while (popupRoot.parentElement && (!closeElement || !popupRoot.contains(closeElement))) {
      popupRoot = popupRoot.parentElement;
    }

    const descendants = [popupRoot, ...Array.from(popupRoot.querySelectorAll('*'))];
    let scrollBox: PopupScrollBox | null = null;
    let largestScrollRange = 12;
    const tabs: PopupTab[] = [];
    const scrollCandidates: PopupScrollCandidate[] = [];

    for (const element of descendants) {
      const htmlElement = element as HTMLElement;
      const rect = htmlElement.getBoundingClientRect();
      const style = window.getComputedStyle(htmlElement);
      const visible = rect.width > 0
        && rect.height > 0
        && style.display !== 'none'
        && style.visibility !== 'hidden';
      if (!visible) continue;

      const scrollRange = htmlElement.scrollHeight - htmlElement.clientHeight;
      const containsAction = element.contains(continueElement)
        || Boolean(closeElement && element.contains(closeElement));
      if (scrollRange > 0) {
        scrollCandidates.push({
          tagName: htmlElement.tagName,
          className: typeof htmlElement.className === 'string' ? htmlElement.className : '',
          scrollRange,
          containsAction,
        });
      }
      if (scrollRange > largestScrollRange && !containsAction && style.overflowY !== 'hidden') {
        largestScrollRange = scrollRange;
        scrollBox = {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          tagName: htmlElement.tagName,
          className: typeof htmlElement.className === 'string' ? htmlElement.className : '',
          scrollTop: htmlElement.scrollTop,
          scrollHeight: htmlElement.scrollHeight,
          clientHeight: htmlElement.clientHeight,
        };
      }

      if (element === continueElement || element === closeElement) continue;
      const testId = htmlElement.getAttribute('jing-testid')?.toLowerCase() ?? '';
      const dataTestId = htmlElement.getAttribute('data-testid')?.toLowerCase() ?? '';
      const className = typeof htmlElement.className === 'string'
        ? htmlElement.className.toLowerCase()
        : '';
      const role = htmlElement.getAttribute('role')?.toLowerCase() ?? '';
      const looksLikeTab = role === 'tab'
        || testId.includes('tab')
        || dataTestId.includes('tab')
        || className.includes('tab');
      const label = (htmlElement.innerText || htmlElement.textContent || '').trim();
      if (!looksLikeTab || label.length === 0) continue;

      tabs.push({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        label,
        active: htmlElement.getAttribute('aria-selected') === 'true'
          || className.includes('active')
          || className.includes('selected')
          || className.includes('current'),
      });
    }

    // 父子 TAB 容器可能同时命中 class="tab"，只保留最小的可点击节点。
    const topLevelTabs: PopupTab[] = [];
    for (let index = 0; index < tabs.length; index += 1) {
      const tab = tabs[index];
      let nested = false;
      for (let otherIndex = 0; otherIndex < tabs.length; otherIndex += 1) {
        if (otherIndex === index) continue;
        const other = tabs[otherIndex];
        if (
          other.x >= tab.x
          && other.y >= tab.y
          && other.x + other.width <= tab.x + tab.width
          && other.y + other.height <= tab.y + tab.height
          && (other.width < tab.width || other.height < tab.height)
        ) {
          nested = true;
          break;
        }
      }
      if (!nested) topLevelTabs.push(tab);
    }

    const popupRect = (popupRoot as HTMLElement).getBoundingClientRect();
    const continueBottom = continueRect.y;
    let contentTop = popupRect.y + 20;
    for (const tab of topLevelTabs) {
      contentTop = Math.max(contentTop, tab.y + tab.height + 8);
    }
    const gestureBox = continueBottom - contentTop > 80
      ? {
        x: popupRect.x,
        y: contentTop,
        width: popupRect.width,
        height: continueBottom - contentTop,
      }
      : null;

    const contentParts: string[] = [];
    const contentElements = popupRoot.querySelectorAll('h1, h2, h3, h4, p, li');
    for (const element of contentElements) {
      const htmlElement = element as HTMLElement;
      const rect = htmlElement.getBoundingClientRect();
      const text = (htmlElement.innerText || htmlElement.textContent || '').trim().replace(/\s+/g, ' ');
      if (
        text.length > 2
        && rect.width > 0
        && rect.height > 0
        && rect.top >= contentTop - 20
        && rect.bottom <= continueBottom + 20
      ) {
        contentParts.push(`${text.slice(0, 36)}@${Math.round(rect.top)}`);
        if (contentParts.length >= 8) break;
      }
    }

    return {
      scrollBox,
      gestureBox,
      contentSignature: contentParts.join('|'),
      tabs: topLevelTabs,
      scrollCandidates,
    };
  }, {
    agreementContinue: LOCATORS.agreementContinue,
    agreementClose: LOCATORS.agreementClose,
  });
}

async function scrollAgreementPopupContent(
  page: Page,
  random: () => number,
  step: string,
) {
  const beforeUi = await getAgreementPopupUi(page);
  const { scrollBox } = beforeUi;
  const gestureBox = scrollBox ?? beforeUi.gestureBox;
  if (!gestureBox) {
    const candidates = beforeUi.scrollCandidates
      .map((candidate) => `${candidate.tagName}.${candidate.className || '无 class'}=${candidate.scrollRange}${candidate.containsAction ? '(含按钮)' : ''}`)
      .join('，');
    mark(`${step}：未找到协议正文滚动容器${candidates ? `，候选：${candidates}` : ''}`);
    return false;
  }

  const distance = Math.round(randomBetween(random, gestureBox.height * 0.28, gestureBox.height * 0.55));
  const duration = Math.round(randomBetween(random, 450, 900));
  const chunks = randomBetween(random, 0, 1) < 0.35 ? 3 : 2;
  const chunkDuration = duration / chunks;
  const x = gestureBox.x + gestureBox.width / 2;
  const startY = gestureBox.y + gestureBox.height * 0.68;
  const endY = Math.max(gestureBox.y + gestureBox.height * 0.25, startY - distance);

  // 协议正文在 iframe 中时直接走 iframe 的分段滚动；避免先对外层弹窗发触摸事件，
  // 造成首次浏览出现突兀跳动，再由 iframe 兜底修正。
  const iframeScrolled = await scrollAgreementIframe(page, distance, random, step);
  if (iframeScrolled) return true;
  if (await readingMaskIsVisible(page)) return false;

  // 移动端协议弹窗通常不响应 wheel，使用 CDP 触摸事件模拟真实手指上滑。
  const client = await page.context().newCDPSession(page);
  let touchInterrupted = false;
  try {
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y: startY, id: 1 }],
    });
    for (let chunk = 0; chunk < chunks; chunk += 1) {
      if (await readingMaskIsVisible(page)) {
        touchInterrupted = true;
        mark(`${step}：蒙层出现，立即停止协议触摸滑动`);
        break;
      }
      const progress = (chunk + 1) / chunks;
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x, y: startY + (endY - startY) * progress, id: 1 }],
      });
      await sleep(chunkDuration);
    }
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
  } finally {
    await client.detach();
  }

  const afterUi = await getAgreementPopupUi(page);
  const afterScrollTop = afterUi.scrollBox?.scrollTop ?? 0;
  const scrollChanged = Boolean(scrollBox && afterScrollTop > scrollBox.scrollTop + 1);
  const contentChanged = Boolean(
    beforeUi.contentSignature
    && afterUi.contentSignature
    && beforeUi.contentSignature !== afterUi.contentSignature,
  );
  if (touchInterrupted && !scrollChanged && !contentChanged) return false;
  if (!scrollChanged && !contentChanged) {
    const targetDescription = scrollBox
      ? `${scrollBox.tagName}.${scrollBox.className || '无 class'}，${scrollBox.scrollTop}/${scrollBox.scrollHeight - scrollBox.clientHeight}`
      : `触摸区域 ${Math.round(gestureBox.x)},${Math.round(gestureBox.y)},${Math.round(gestureBox.width)}x${Math.round(gestureBox.height)}`;
    const iframeLocator = page.locator('iframe');
    const iframeDescriptions: string[] = [];
    const iframeCount = await iframeLocator.count();
    for (let index = 0; index < iframeCount; index += 1) {
      const iframe = iframeLocator.nth(index);
      if (!await iframe.isVisible().catch(() => false)) continue;
      const box = await iframe.boundingBox().catch(() => null);
      const src = await iframe.getAttribute('src').catch(() => null);
      if (box) iframeDescriptions.push(`${src || '无 src'}@${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.width)}x${Math.round(box.height)}`);
    }
    const frameUrls = page.frames().map((frame) => frame.url()).filter(Boolean).join(' | ');
    mark(`${step}：协议内容触摸滑动未改变内容位置（${targetDescription}；iframe=${iframeDescriptions.join('，') || '无'}；frames=${frameUrls || '无'}）`);
    return false;
  }
  mark(`${step}：滑动协议内容浏览`);
  return true;
}

async function stopAgreementScrollWhenMasked(
  page: Page,
  agreementFrame: Frame,
  currentY: number,
  step: string,
) {
  if (!await readingMaskIsVisible(page)) return false;
  await agreementFrame.evaluate((targetY) => {
    document.documentElement.style.scrollBehavior = 'auto';
    if (document.body) document.body.style.scrollBehavior = 'auto';
    window.scrollTo(0, targetY);
  }, currentY).catch(() => undefined);
  mark(`${step}：蒙层出现，立即停止协议滚动`);
  return true;
}

async function scrollAgreementIframe(page: Page, distance: number, random: () => number, step: string) {
  let agreementFrame: Frame | undefined;
  const iframeLocator = page.locator('iframe');
  const iframeCount = await iframeLocator.count();
  for (let index = 0; index < iframeCount && !agreementFrame; index += 1) {
    const iframe = iframeLocator.nth(index);
    if (!await iframe.isVisible().catch(() => false)) continue;
    const src = await iframe.getAttribute('src').catch(() => null);
    const box = await iframe.boundingBox().catch(() => null);
    if (!box || box.width <= 0 || box.height <= 0) continue;
    agreementFrame = page.frames().find((frame) => (
      frame !== page.mainFrame()
      && (!src || frame.url().includes(src))
    ));
  }
  if (!agreementFrame) {
    agreementFrame = page.frames().find((frame) => frame !== page.mainFrame() && Boolean(frame.url()));
  }
  if (!agreementFrame) return false;

  try {
    if (await readingMaskIsVisible(page)) return false;
    const before = await agreementFrame.evaluate(() => ({
      y: window.scrollY || document.scrollingElement?.scrollTop || 0,
      maxY: Math.max(
        0,
        (document.scrollingElement?.scrollHeight ?? 0)
          - (document.scrollingElement?.clientHeight ?? window.innerHeight),
      ),
    }));
    await agreementFrame.evaluate(() => {
      document.documentElement.style.scrollBehavior = 'auto';
      if (document.body) document.body.style.scrollBehavior = 'auto';
    });

    // 参考 mobile-browse：按当前阅读位置决定继续下滑或小幅回滑，避免每次都机械下滚。
    const canScrollDown = before.y < before.maxY - 4;
    const canBacktrack = before.y > 4;
    const direction = canScrollDown || !canBacktrack ? 1 : -1;
    const travel = direction > 0
      ? Math.min(distance, before.maxY - before.y)
      : -Math.min(distance * randomBetween(random, 0.18, 0.36), before.y);
    if (Math.abs(travel) < 2) {
      await sleep(Math.round(randomBetween(random, 700, 1_600)));
      return false;
    }

    const duration = randomBetween(random, 700, 1_500);
    const chunks = randomInteger(random, 2, 3);
    const chunkDuration = duration / chunks;
    let currentY = before.y;

    for (let chunk = 0; chunk < chunks; chunk += 1) {
      const chunkSteps = randomInteger(random, 12, 18);
      const chunkStartY = currentY;
      const chunkTargetY = before.y + travel * ((chunk + 1) / chunks);
      for (let gestureStep = 1; gestureStep <= chunkSteps; gestureStep += 1) {
        if (
          (gestureStep === 1 || gestureStep % 2 === 0)
          && await stopAgreementScrollWhenMasked(page, agreementFrame, currentY, step)
        ) {
          return Math.abs(currentY - before.y) > 1;
        }
        const progress = gestureStep / chunkSteps;
        const eased = 1 - Math.pow(1 - progress, 2);
        currentY = chunkStartY + (chunkTargetY - chunkStartY) * eased;
        await agreementFrame.evaluate((targetY) => {
          window.scrollTo(0, targetY);
        }, currentY);
        await sleep(chunkDuration / chunkSteps);
      }
      if (chunk < chunks - 1) {
        await sleep(Math.round(randomBetween(random, 500, 1_200)));
      }
    }

    // 少量用户会回看刚刚掠过的内容，再继续阅读。
    if (direction > 0 && random() < 0.18 && currentY > 8) {
      const backtrack = Math.min(
        currentY,
        Math.round(randomBetween(random, 0.08 * distance, 0.16 * distance)),
      );
      const backtrackSteps = randomInteger(random, 8, 13);
      const backtrackStartY = currentY;
      for (let gestureStep = 1; gestureStep <= backtrackSteps; gestureStep += 1) {
        if (
          (gestureStep === 1 || gestureStep % 2 === 0)
          && await stopAgreementScrollWhenMasked(page, agreementFrame, currentY, step)
        ) {
          return Math.abs(currentY - before.y) > 1;
        }
        const progress = gestureStep / backtrackSteps;
        const eased = 1 - Math.pow(1 - progress, 2);
        currentY = backtrackStartY - backtrack * eased;
        await agreementFrame.evaluate((targetY) => {
          window.scrollTo(0, targetY);
        }, currentY);
        await sleep(randomBetween(random, 35, 75));
      }
      await sleep(Math.round(randomBetween(random, 400, 1_000)));
    }

    // 手势结束后模拟停下来阅读，而不是立即触发下一次滚动。
    await sleep(Math.round(randomBetween(random, 700, 1_800)));
    const after = await agreementFrame.evaluate(() => ({
      y: window.scrollY || document.scrollingElement?.scrollTop || 0,
    }));
    const changed = Math.abs(after.y - before.y) > 1;
    if (changed) mark(`${step}：iframe 协议正文已滚动（${agreementFrame.url()}）`);
    return changed;
  } catch {
    return false;
  }
}

async function switchAgreementTab(
  page: Page,
  random: () => number,
  step: string,
  visitedLabels: ReadonlySet<string>,
): Promise<PopupTab | null> {
  const beforeUi = await getAgreementPopupUi(page);
  const { tabs } = beforeUi;
  const viewport = page.viewportSize() ?? iPhone15Screen;
  const availableTabs = tabs.filter((tab) => (
    !tab.active
    && !visitedLabels.has(tab.label)
    && tab.x + tab.width / 2 > 8
    && tab.x + tab.width / 2 < viewport.width - 8
    && tab.y + tab.height / 2 > 0
    && tab.y + tab.height / 2 < viewport.height
  ));
  if (availableTabs.length === 0) {
    mark(`${step}：当前视口未找到新的可切换协议 TAB（tabs=${tabs.length}）`);
    return null;
  }

  const target = pick(random, availableTabs);
  const beforeFrameSignature = page.frames()
    .filter((frame) => frame !== page.mainFrame())
    .map((frame) => frame.url())
    .join('|');
  // 目标中心已确认在手机视口内，直接按当前坐标点击，避免 Locator.click 的
  // scrollIntoView 把横向 TAB 栏突兀地滚到其他位置。
  await page.mouse.click(target.x + target.width / 2, target.y + target.height / 2);
  await waitConfigured(random, 500, 1_000);
  let afterClickUi = await getAgreementPopupUi(page);
  let targetActive = afterClickUi.tabs.some((tab) => tab.label === target.label && tab.active);
  let afterFrameSignature = page.frames()
    .filter((frame) => frame !== page.mainFrame())
    .map((frame) => frame.url())
    .join('|');
  let contentChanged = beforeFrameSignature !== afterFrameSignature;
  if (!targetActive && !contentChanged) {
    const domClicked = await page.evaluate(({ label, x, y }) => {
      const candidates = Array.from(document.querySelectorAll('[role="tab"], [class*="tab"]'))
        .filter((element) => {
          const htmlElement = element as HTMLElement;
          const rect = htmlElement.getBoundingClientRect();
          const text = (htmlElement.innerText || htmlElement.textContent || '').trim();
          const style = window.getComputedStyle(htmlElement);
          return text === label
            && rect.width > 0
            && rect.height > 0
            && style.display !== 'none'
            && style.visibility !== 'hidden';
        })
        .sort((left, right) => {
          const leftRect = (left as HTMLElement).getBoundingClientRect();
          const rightRect = (right as HTMLElement).getBoundingClientRect();
          const leftDistance = Math.hypot(
            leftRect.x + leftRect.width / 2 - x,
            leftRect.y + leftRect.height / 2 - y,
          );
          const rightDistance = Math.hypot(
            rightRect.x + rightRect.width / 2 - x,
            rightRect.y + rightRect.height / 2 - y,
          );
          return leftDistance - rightDistance;
        });
      const candidate = candidates[0] as HTMLElement | undefined;
      if (!candidate) return false;
      candidate.click();
      return true;
    }, {
      label: target.label,
      x: target.x + target.width / 2,
      y: target.y + target.height / 2,
    });
    if (domClicked) {
      await sleep(800);
      afterClickUi = await getAgreementPopupUi(page);
      targetActive = afterClickUi.tabs.some((tab) => tab.label === target.label && tab.active);
      afterFrameSignature = page.frames()
        .filter((frame) => frame !== page.mainFrame())
        .map((frame) => frame.url())
        .join('|');
      contentChanged = beforeFrameSignature !== afterFrameSignature;
    }
  }
  if (!targetActive && !contentChanged) {
    mark(`${step}：TAB「${target.label}」点击后未确认切换生效`);
    return null;
  }
  mark(`${step}：切换协议 TAB「${target.label}」`);
  return target;
}

/**
 * 按有效浏览时长执行 TAB 阅读。蒙版存在期间暂停计时，关闭后从当前 TAB 继续。
 * 关闭连续失败时抛错，避免在蒙版下无限空转或穿透操作。
 */
export async function runInterruptibleAgreementBrowse(
  options: InterruptibleAgreementBrowseOptions,
) {
  let remainingMs = Math.max(0, options.durationMs);
  let browseConfirmed = false;
  let overlayDismissals = 0;
  let overlayOccurrences = 0;

  const consumeActiveTime = (startedAt: number, fallbackMs = 0) => {
    const elapsedMs = Math.max(fallbackMs, options.now() - startedAt);
    remainingMs = Math.max(0, remainingMs - elapsedMs);
    return elapsedMs;
  };

  while (remainingMs > 0) {
    if (await options.isOverlayVisible()) {
      if (overlayOccurrences >= options.maxOverlayOccurrences) {
        throw new Error(
          `二次蒙版处理已达 ${options.maxOverlayOccurrences} 次上限，停止 TAB 浏览`,
        );
      }
      overlayOccurrences += 1;
      const dismissed = await options.dismissOverlay();
      if (dismissed) {
        overlayDismissals += 1;
      }
      continue;
    }

    const browseStartedAt = options.now();
    browseConfirmed = await options.browseOnce() || browseConfirmed;
    consumeActiveTime(browseStartedAt);
    if (remainingMs <= 0) break;

    // 滚动期间也可能弹出蒙版；先进入下一轮蒙版处理，不再发起新滚动。
    if (await options.isOverlayVisible()) continue;

    let pauseRemainingMs = Math.min(
      remainingMs,
      Math.max(0, options.nextPauseMs()),
    );
    while (pauseRemainingMs > 0) {
      if (await options.isOverlayVisible()) break;
      const sliceMs = Math.min(readingWaitPollMs, pauseRemainingMs);
      const pauseStartedAt = options.now();
      await options.wait(sliceMs);
      const consumedMs = consumeActiveTime(pauseStartedAt, sliceMs);
      pauseRemainingMs = Math.max(0, pauseRemainingMs - consumedMs);
      if (remainingMs <= 0) break;
    }
  }

  return { browseConfirmed, overlayDismissals };
}

async function browseAgreementForDuration(
  page: Page,
  random: () => number,
  step: string,
  context: string,
) {
  const durationMs = Math.round(randomBetween(
    random,
    agreementPostOverlayBrowseMinMs,
    agreementPostOverlayBrowseMaxMs,
  ));
  mark(`${step}：${context} ${Math.round(durationMs / 100) / 10} 秒`);
  const result = await runInterruptibleAgreementBrowse({
    durationMs,
    maxOverlayOccurrences: agreementSecondaryOverlayMaxOccurrences,
    now: Date.now,
    browseOnce: () => scrollAgreementPopupContent(page, random, step),
    isOverlayVisible: () => readingMaskIsVisible(page),
    dismissOverlay: async () => {
      mark(`${step}：二次蒙版出现，暂停当前 TAB 浏览`);
      await waitConfigured(random, readingOverlayReactionMinMs, readingOverlayReactionMaxMs);
      const dismissed = await dismissReadingOverlay(
        page,
        LOCATORS.agreementClose,
        `${step}二次蒙版`,
      );
      if (dismissed) {
        await waitConfigured(
          random,
          readingOverlayAfterDismissMinMs,
          readingOverlayAfterDismissMaxMs,
        );
        mark(`${step}：二次蒙版已关闭，继续浏览当前 TAB`);
      }
      return dismissed;
    },
    wait: sleep,
    nextPauseMs: () => Math.round(randomBetween(random, 400, 900)),
  });

  return result.browseConfirmed;
}

async function handleAgreementAfterOverlayDismiss(
  page: Page,
  random: () => number,
  step: string,
) {
  const behavior = chooseAgreementAfterOverlayBehavior(random);
  if (behavior === 'direct') {
    mark(`${step}：关闭蒙层后直接点击同意并继续`);
    return { browseConfirmed: false, finishBrowsing: true };
  }

  if (behavior === 'continue-current') {
    const browseConfirmed = await browseAgreementForDuration(
      page,
      random,
      step,
      '关闭蒙层后继续浏览当前协议',
    );
    return { browseConfirmed, finishBrowsing: true };
  }

  mark(`${step}：关闭蒙层后已停留 0.5–1 秒，准备切换 TAB`);

  const currentUi = await getAgreementPopupUi(page);
  const viewport = page.viewportSize() ?? iPhone15Screen;
  const currentTab = currentUi.tabs.find((tab) => tab.active)
    ?? currentUi.tabs.find((tab) => (
      tab.x < viewport.width
      && tab.x + tab.width > 0
      && tab.y < viewport.height
      && tab.y + tab.height > 0
    ));
  const visitedLabels = new Set<string>();
  if (currentTab) visitedLabels.add(currentTab.label);

  const firstTarget = await switchAgreementTab(page, random, step, visitedLabels);
  if (!firstTarget) return { browseConfirmed: false, finishBrowsing: true };
  visitedLabels.add(firstTarget.label);

  if (!chooseAgreementBrowseAfterTabSwitch(random)) {
    mark(`${step}：切换 TAB 后不再浏览，直接点击同意并继续`);
    return { browseConfirmed: false, finishBrowsing: true };
  }

  const targetTotal = chooseAgreementTabBrowseTotal(random);
  let browseConfirmed = await browseAgreementForDuration(
    page,
    random,
    step,
    `浏览 TAB「${firstTarget.label}」`,
  );

  while (visitedLabels.size < targetTotal) {
    await waitConfigured(random, 350, 800);
    const nextTarget = await switchAgreementTab(page, random, step, visitedLabels);
    if (!nextTarget) break;
    visitedLabels.add(nextTarget.label);
    browseConfirmed = await browseAgreementForDuration(
      page,
      random,
      step,
      `浏览 TAB「${nextTarget.label}」`,
    ) || browseConfirmed;
  }

  mark(`${step}：本次共浏览 ${visitedLabels.size} 个不同 TAB，准备点击同意并继续`);
  return { browseConfirmed, finishBrowsing: true };
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
    await waitForAnyVisible(
      byTestId(page, LOCATORS.agreementContinue),
      10_000,
      `${flowLabel}协议弹窗`,
    );
  }
  const shouldBrowseAgreement = options.waitAgreement && chooseAgreementPopupBrowse(random);
  if (shouldBrowseAgreement) {
    mark(`${flowLabel}步骤 ${agreementStep}：协议弹窗浏览等待 1–5 秒`);
    const agreementBrowseResult = await waitWhileBrowsing(
      page,
      LOCATORS.agreementClose,
      random,
      1_000,
      5_000,
      `${flowLabel}步骤 ${agreementStep}`,
      {
        onBrowse: () => scrollAgreementPopupContent(
          page,
          random,
          `${flowLabel}步骤 ${agreementStep}`,
        ),
        onOverlayDismiss: () => handleAgreementAfterOverlayDismiss(
          page,
          random,
          `${flowLabel}步骤 ${agreementStep}`,
        ),
      },
    );
    if (!agreementBrowseResult.browseConfirmed) {
      throw new Error(`${flowLabel}步骤 ${agreementStep}：协议内容未发生有效滚动，禁止进入产品选择`);
    }
  } else if (options.waitAgreement) {
    mark(`${flowLabel}步骤 ${agreementStep}：本次用户跳过协议内容浏览，等待 1–3 秒后继续`);
    await waitConfigured(random, 1_000, 3_000);
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
  const phoneResult = await fillPhone({
    page,
    value: order.phone,
    seed: options.seed,
    inputStrategy: options.inputStrategy,
    errorChance: options.phoneErrorChance,
  });
  if (phoneResult.strategy === 'error-corrected') {
    // 错误手机号分支已在 fillPhone 内完成：确认弹窗、等待 2–3 秒、手机号修正和修正后 1 秒停顿。
    mark('首单步骤 2–3：错误手机号已确认并修正，直接进入姓名输入');
  } else {
    await pauseAfterStep(random);
    // 步骤 2：如果出现手机号确认弹窗，点击“同意并继续”。
    mark('首单步骤 2：处理手机号确认弹窗');
    await clickIfAppears(page, LOCATORS.phoneContinue);
    await pauseAfterStep(random);

    // 步骤 3：等待页面切换到实名信息区域。
    mark('首单步骤 3：等待页面进入实名信息');
    await waitConfigured(random, 2_000, 3_000);
    await pauseAfterStep(random);
  }

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
    mark('首单步骤 6：协议勾选完成，等待 1 秒');
    await sleep(agreementToButtonDelayMs);

    if (preButtonPath === 'agreement-only') {
      // 协议勾选方案不再预览页面，等待 0.5 秒后直接进入登录/完善信息。
      mark('首单步骤 7–8：协议勾选完成，跳过预览并直接点击按钮');
    } else {
      // 完整浏览方案才启动步骤 7–8 的 4–12 秒整体预览预算。
      const browseSession = startFirstOrderPageBrowse(random);

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
      await finishFirstOrderPageBrowse(browseSession, '首单步骤 6–8');
    }
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
  const startedAt = Date.now();
  const runLabel = `订单 ${order.orderId} / 流程 ${order.pageOrder}`;
  logger.info(`${runLabel} 开始执行`);

  try {
    // macOS 的 Chrome/Chromium 需要访问沙箱禁止的系统服务；在浏览器启动前给出明确提示。
    assertBrowserLaunchAllowed();

    // 每个订单使用独立浏览器上下文；原生录像在 context 关闭时完成写入。
    const outputDir = options.outputDir || defaultOutputDir;
    const pendingDir = resolve(outputDir, '.pending');
    await mkdir(pendingDir, { recursive: true });

    selectors.setTestIdAttribute('jing-testid');

    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let nativeVideo: ReturnType<Page['video']> | undefined;
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
      browser = await chromium.launch({
        headless: options.headless,
        channel: process.env.PW_CHANNEL || options.browserChannel,
      });
      context = await browser.newContext({
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
      nativeVideo = page.video();
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
        if (context) await context.close();
        if (nativeVideo) recordedPath = await nativeVideo.path();
      } catch (error) {
        if (!failure) failure = error;
      }
      try {
        if (browser) await browser.close();
      } catch (error) {
        if (!failure) failure = error;
      }
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

    const result = {
      orderId: order.orderId,
      pageOrder: order.pageOrder,
      success,
      videoPath,
    };
    logger.info(`${runLabel} 执行成功，耗时 ${formatDuration(startedAt)}${videoPath ? `，视频：${videoPath}` : ''}`);
    return result;
  } catch (error) {
    logger.error(`${runLabel} 执行失败，耗时 ${formatDuration(startedAt)}`, error);
    throw error;
  }
}
