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
        await pause({
          minMs: profileConfig.microPauseMin,
          maxMs: profileConfig.microPauseMax,
        });
      }
    }
    await pause();

    let backtracked = false;
    if (allowBacktrack && random() < profileConfig.backtrackChance) {
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
      if (swipe < maxSwipes) await scroll();
    }
    throw new Error(`经过 ${maxSwipes} 次滑动后目标仍不可见`);
  }

  return Object.freeze({ pause, scroll, scrollUntilVisible });
}
