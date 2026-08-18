import type { Locator, Page } from '@playwright/test';
import { createSeededRandom, randomBetween, randomInteger } from './random';
import type { BrowseProfile, HumanBrowseBehavior, WaitFn } from './types';

export const BROWSE_PROFILES = Object.freeze({
  skimmer: Object.freeze({
    minScrollRatio: 0.45,
    maxScrollRatio: 0.76,
    minDuration: 430,
    maxDuration: 760,
    pauseMin: 220,
    pauseMax: 620,
    backtrackChance: 0.04,
  }),
  reader: Object.freeze({
    minScrollRatio: 0.25,
    maxScrollRatio: 0.52,
    minDuration: 680,
    maxDuration: 1120,
    pauseMin: 700,
    pauseMax: 1700,
    backtrackChance: 0.2,
  }),
  distracted: Object.freeze({
    minScrollRatio: 0.2,
    maxScrollRatio: 0.42,
    minDuration: 380,
    maxDuration: 920,
    pauseMin: 260,
    pauseMax: 2200,
    backtrackChance: 0.32,
  }),
});

const defaultWait: WaitFn = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs));

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
    const steps = randomInteger(random, 18, 32);

    await performGesture(distance, duration, steps);
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

  async function scrollUntilVisible(locator: Locator, { maxSwipes = 5 } = {}) {
    for (let swipe = 0; swipe <= maxSwipes; swipe += 1) {
      if (await locator.isVisible()) return { swipes: swipe };
      if (swipe < maxSwipes) await scroll();
    }
    throw new Error(`经过 ${maxSwipes} 次滑动后目标仍不可见`);
  }

  return Object.freeze({ pause, scroll, scrollUntilVisible });
}
