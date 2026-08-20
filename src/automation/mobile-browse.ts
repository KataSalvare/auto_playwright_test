import type { Locator, Page } from '@playwright/test';
import { createSeededRandom, randomBetween, randomInteger } from './random';
import type { BrowseProfile, HumanBrowseBehavior, WaitFn } from './types';

export const BROWSE_PROFILES = Object.freeze({
  skimmer: Object.freeze({
    minScrollRatio: 0.28,
    maxScrollRatio: 0.48,
    minDuration: 900,
    maxDuration: 1_700,
    microPauseMin: 450,
    microPauseMax: 900,
    pauseMin: 1_000,
    pauseMax: 2_400,
    backtrackChance: 0.08,
  }),
  reader: Object.freeze({
    minScrollRatio: 0.18,
    maxScrollRatio: 0.34,
    minDuration: 1_200,
    maxDuration: 2_400,
    microPauseMin: 700,
    microPauseMax: 1_600,
    pauseMin: 1_800,
    pauseMax: 4_200,
    backtrackChance: 0.28,
  }),
  distracted: Object.freeze({
    minScrollRatio: 0.12,
    maxScrollRatio: 0.26,
    minDuration: 800,
    maxDuration: 1_800,
    microPauseMin: 550,
    microPauseMax: 1_300,
    pauseMin: 1_000,
    pauseMax: 3_200,
    backtrackChance: 0.36,
  }),
});

const defaultWait: WaitFn = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs));

/** 判断元素是否真正进入当前 viewport，而不是只存在于 DOM 中。 */
export async function isLocatorInViewport(locator: Locator): Promise<boolean> {
  const box = await locator.boundingBox().catch(() => null);
  const viewport = locator.page().viewportSize();
  if (!box || !viewport) return false;
  return box.x < viewport.width
    && box.y < viewport.height
    && box.x + box.width > 0
    && box.y + box.height > 0;
}

/** 判断页面滚动位置是否已经到达底部。 */
export async function isPageAtBottom(page: Page, threshold = 8): Promise<boolean> {
  return page.evaluate((bottomThreshold) => {
    const documentElement = document.documentElement;
    const bodyHeight = document.body?.scrollHeight ?? 0;
    const documentHeight = Math.max(documentElement.scrollHeight, bodyHeight);
    return window.scrollY + window.innerHeight >= documentHeight - bottomThreshold;
  }, threshold);
}

export function createMobileBrowseBehavior({
  page,
  profile = 'reader',
  seed = Date.now(),
  wait = defaultWait,
}: {
  page: Page;
  profile?: BrowseProfile;
  seed?: number;
  wait?: WaitFn;
}): HumanBrowseBehavior {
  const profileConfig = BROWSE_PROFILES[profile];
  if (!profileConfig) throw new Error(`未知移动浏览画像：${profile}`);
  if (!Number.isInteger(seed)) throw new Error(`seed 必须是整数，当前值：${seed}`);

  const viewport = page.viewportSize();
  if (!viewport || viewport.height <= 0) {
    throw new Error('Playwright Page 必须配置有效的 viewport 高度');
  }
  const viewportHeight = viewport.height;

  const random = createSeededRandom(seed);

  async function performGesture(distance: number, duration: number, steps: number) {
    let moved = 0;
    for (let step = 1; step <= steps; step += 1) {
      const progress = step / steps;
      const eased = 1 - Math.pow(1 - progress, 2);
      const target = distance * eased;
      await page.mouse.wheel(0, target - moved);
      moved = target;
      await wait(duration / steps);
    }
  }

  async function pause({
    minMs = profileConfig.pauseMin,
    maxMs = profileConfig.pauseMax,
  }: { minMs?: number; maxMs?: number } = {}) {
    if (minMs > maxMs) throw new Error(`pause 的 minMs 不能大于 maxMs：${minMs} > ${maxMs}`);
    const duration = randomBetween(random, minMs, maxMs);
    await wait(duration);
    return { duration };
  }

  async function scroll({ allowBacktrack = true } = {}) {
    // 到达页面底部后，浏览器可能仍然接受 wheel 事件并触发滚动动画。
    // 先做边界检查，避免在底部反复发送无效的下滚指令造成画面抖动。
    if (await isPageAtBottom(page)) {
      return {
        distance: 0,
        duration: 0,
        steps: 0,
        backtracked: false,
      };
    }

    const distance = viewportHeight * randomBetween(
      random,
      profileConfig.minScrollRatio,
      profileConfig.maxScrollRatio,
    );
    const duration = randomBetween(random, profileConfig.minDuration, profileConfig.maxDuration);
    const chunks = randomInteger(random, 2, 3);
    const chunkDistance = distance / chunks;
    const chunkDuration = duration / chunks;
    let steps = 0;

    for (let chunk = 0; chunk < chunks; chunk += 1) {
      const chunkSteps = randomInteger(random, 12, 18);
      steps += chunkSteps;
      await performGesture(chunkDistance, chunkDuration, chunkSteps);
      if (chunk < chunks - 1) {
        // 一次手势可能在分段中途抵达底部，立即结束本次手势，
        // 防止后续分段继续向下发送无效 wheel 事件。
        if (await isPageAtBottom(page)) break;
        await pause({
          minMs: profileConfig.microPauseMin,
          maxMs: profileConfig.microPauseMax,
        });
      }
    }
    await pause();

    let backtracked = false;
    // 到底部后不执行反向回滚，避免“下滚到边界后立即上回滚”造成视觉抖动。
    const reachedBottom = await isPageAtBottom(page);
    if (!reachedBottom && allowBacktrack && random() < profileConfig.backtrackChance) {
      const backtrackDistance = viewportHeight * randomBetween(random, 0.08, 0.18);
      const backtrackDuration = randomBetween(random, 300, 540);
      const backtrackSteps = randomInteger(random, 12, 19);
      await performGesture(-backtrackDistance, backtrackDuration, backtrackSteps);
      await pause({ minMs: 350, maxMs: 900 });
      backtracked = true;
    }

    return { distance, duration, steps, backtracked };
  }

  async function scrollUntilVisible(locator: Locator, { maxSwipes = 8 } = {}) {
    for (let swipe = 0; swipe <= maxSwipes; swipe += 1) {
      if (await isLocatorInViewport(locator)) return { swipes: swipe };
      if (swipe < maxSwipes) {
        // 目标仍不在视口且页面已经到底部时，继续下滚没有意义，
        // 直接失败并保留明确原因，避免无效滚动导致视频抖动。
        if (await isPageAtBottom(page)) {
          throw new Error(`页面已到达底部，但目标在 ${maxSwipes} 次浏览后仍不可见`);
        }
        await scroll();
      }
    }
    throw new Error(`经过 ${maxSwipes} 次滑动后目标仍不可见`);
  }

  async function scrollToBottom({ maxSwipes = 12, pauseAtBottom = true } = {}) {
    for (let swipe = 0; swipe <= maxSwipes; swipe += 1) {
      if (await isPageAtBottom(page)) {
        if (pauseAtBottom) await pause();
        return { swipes: swipe };
      }
      if (swipe < maxSwipes) await scroll({ allowBacktrack: false });
    }
    throw new Error(`经过 ${maxSwipes} 次浏览后页面仍未到达底部`);
  }

  return Object.freeze({ pause, scroll, scrollUntilVisible, scrollToBottom });
}
