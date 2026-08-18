import { test, expect } from '@playwright/test';
import { createMobileBrowseBehavior } from '../../src/automation/mobile-browse';

function createFakePage() {
  const wheelDeltas: number[] = [];
  return {
    page: {
      viewportSize: () => ({ width: 390, height: 844 }),
      mouse: {
        wheel: async (_deltaX: number, deltaY: number) => wheelDeltas.push(deltaY),
      },
    } as never,
    wheelDeltas,
  };
}

function createBehavior(seed: number) {
  const fake = createFakePage();
  const waits: number[] = [];
  const browse = createMobileBrowseBehavior({
    page: fake.page,
    profile: 'reader',
    seed,
    wait: async (duration) => {
      waits.push(duration);
    },
  });
  return { ...fake, browse, waits };
}

test('相同 seed 生成相同的滚动轨迹', async () => {
  const first = createBehavior(20260818);
  const second = createBehavior(20260818);

  const firstResult = await first.browse.scroll();
  const secondResult = await second.browse.scroll();

  expect(firstResult).toEqual(secondResult);
  expect(first.wheelDeltas).toEqual(second.wheelDeltas);
  expect(first.waits).toEqual(second.waits);
});

test('scrollUntilVisible 在目标出现后停止', async () => {
  const fake = createFakePage();
  const browse = createMobileBrowseBehavior({
    page: fake.page,
    profile: 'reader',
    seed: 1,
    wait: async () => {},
  });
  let checks = 0;
  const locator = {
    isVisible: async () => ++checks >= 3,
  } as never;

  await expect(browse.scrollUntilVisible(locator, { maxSwipes: 4 })).resolves.toEqual({ swipes: 2 });
  expect(fake.wheelDeltas.length).toBeGreaterThan(0);
});
