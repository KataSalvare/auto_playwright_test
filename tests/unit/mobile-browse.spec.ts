import { test, expect } from '@playwright/test';
import { createMobileBrowseBehavior } from '../../src/automation/mobile-browse';

function createFakePage(atBottomAfter = Number.MAX_SAFE_INTEGER) {
  const wheelDeltas: number[] = [];
  let bottomChecks = 0;
  return {
    page: {
      viewportSize: () => ({ width: 390, height: 844 }),
      evaluate: async () => {
        bottomChecks += 1;
        return bottomChecks >= atBottomAfter;
      },
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
  expect(firstResult.distance).toBeGreaterThanOrEqual(844 * 0.18);
  expect(firstResult.distance).toBeLessThanOrEqual(844 * 0.34);
  expect(firstResult.steps).toBeGreaterThanOrEqual(24);
  expect(first.waits.length).toBeGreaterThan(firstResult.steps);
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
    boundingBox: async () => {
      checks += 1;
      return checks >= 3
        ? { x: 0, y: 0, width: 100, height: 100 }
        : { x: 0, y: 1_000, width: 100, height: 100 };
    },
    page: () => fake.page,
  } as never;

  await expect(browse.scrollUntilVisible(locator, { maxSwipes: 4 })).resolves.toEqual({ swipes: 2 });
  expect(fake.wheelDeltas.length).toBeGreaterThan(0);
});

test('scrollUntilVisible 不把 DOM 可见误判为视口可见', async () => {
  const fake = createFakePage();
  const browse = createMobileBrowseBehavior({
    page: fake.page,
    profile: 'reader',
    seed: 1,
    wait: async () => {},
  });
  let viewportChecks = 0;
  const locator = {
    boundingBox: async () => {
      viewportChecks += 1;
      return viewportChecks >= 3
        ? { x: 0, y: 0, width: 100, height: 100 }
        : { x: 0, y: 1_000, width: 100, height: 100 };
    },
    page: () => fake.page,
  } as never;

  await expect(browse.scrollUntilVisible(locator, { maxSwipes: 4 })).resolves.toEqual({ swipes: 2 });
});

test('scrollToBottom 到达页面底部后停止，并且不回滑', async () => {
  const fake = createFakePage(3);
  const browse = createMobileBrowseBehavior({
    page: fake.page,
    profile: 'reader',
    seed: 1,
    wait: async () => {},
  });

  await expect(browse.scrollToBottom({ maxSwipes: 4 })).resolves.toEqual({ swipes: 1 });
  expect(fake.wheelDeltas.length).toBeGreaterThan(0);
  expect(fake.wheelDeltas.every((delta) => delta > 0)).toBeTruthy();
});

test('scrollUntilVisible 到达底部后不再继续发送下滚指令', async () => {
  const fake = createFakePage(1);
  const browse = createMobileBrowseBehavior({
    page: fake.page,
    profile: 'reader',
    seed: 1,
    wait: async () => {},
  });
  const locator = {
    boundingBox: async () => ({ x: 0, y: 1_000, width: 100, height: 100 }),
    page: () => fake.page,
  } as never;

  await expect(browse.scrollUntilVisible(locator, { maxSwipes: 4 }))
    .rejects.toThrow('页面已到达底部');
  expect(fake.wheelDeltas).toEqual([]);
});
