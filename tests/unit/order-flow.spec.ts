import { test, expect } from '@playwright/test';
import {
  chooseFirstOrderPreButtonPath,
  chooseRandomBrowseProfile,
  chooseRepeatOrderAgreementPath,
  chooseAgreementPopupBrowse,
  chooseAgreementAfterOverlayBehavior,
  chooseAgreementBrowseAfterTabSwitch,
  chooseAgreementTabBrowseTotal,
  runInterruptibleAgreementBrowse,
} from '../../src/automation/order-flow';

test.describe('首单步骤 5 后的协议/社保/续保分支', () => {
  test('方案 1：社保和续保均为 1 时，大多数用户直接跳过 6–8', () => {
    expect(chooseFirstOrderPreButtonPath(() => 0.79, true, true)).toBe('direct');
  });

  test('方案 2：社保和续保均为 1 时，少数用户只浏览并勾选协议', () => {
    expect(chooseFirstOrderPreButtonPath(() => 0.9, true, true)).toBe('agreement-only');
  });

  test('方案 3：极少数用户或其他状态完整浏览协议、社保和续保', () => {
    expect(chooseFirstOrderPreButtonPath(() => 0.99, true, true)).toBe('full');
    expect(chooseFirstOrderPreButtonPath(() => 0.01, true, false)).toBe('full');
    expect(chooseFirstOrderPreButtonPath(() => 0.01, false, true)).toBe('full');
  });

  test('浏览画像未固定时随机选择三种方案', () => {
    expect(chooseRandomBrowseProfile(() => 0)).toBe('skimmer');
    expect(chooseRandomBrowseProfile(() => 0.34)).toBe('reader');
    expect(chooseRandomBrowseProfile(() => 0.99)).toBe('distracted');
  });

  test('次单步骤 2：大多数直接点击，少数浏览并勾选协议', () => {
    expect(chooseRepeatOrderAgreementPath(() => 0.79)).toBe('direct');
    expect(chooseRepeatOrderAgreementPath(() => 0.99)).toBe('browse-agreement');
  });

  test('wait-agreement=true 时，40% 用户浏览协议弹窗', () => {
    expect(chooseAgreementPopupBrowse(() => 0.39)).toBe(true);
    expect(chooseAgreementPopupBrowse(() => 0.4)).toBe(false);
  });

  test('关闭蒙层后按 25% / 25% / 50% 选择后续行为', () => {
    expect(chooseAgreementAfterOverlayBehavior(() => 0.24)).toBe('direct');
    expect(chooseAgreementAfterOverlayBehavior(() => 0.25)).toBe('continue-current');
    expect(chooseAgreementAfterOverlayBehavior(() => 0.49)).toBe('continue-current');
    expect(chooseAgreementAfterOverlayBehavior(() => 0.5)).toBe('switch-tabs');
  });

  test('切换 TAB 后，80% 用户继续浏览', () => {
    expect(chooseAgreementBrowseAfterTabSwitch(() => 0.79)).toBe(true);
    expect(chooseAgreementBrowseAfterTabSwitch(() => 0.8)).toBe(false);
  });

  test('浏览 TAB 数量按 2 个最多、3 个其次、4 个最少分布', () => {
    expect(chooseAgreementTabBrowseTotal(() => 0.624)).toBe(2);
    expect(chooseAgreementTabBrowseTotal(() => 0.625)).toBe(3);
    expect(chooseAgreementTabBrowseTotal(() => 0.874)).toBe(3);
    expect(chooseAgreementTabBrowseTotal(() => 0.875)).toBe(4);
  });

  test('切换 TAB 后出现二次蒙版时暂停浏览，关闭后从当前 TAB 继续', async () => {
    let now = 0;
    let masked = false;
    let browseCount = 0;
    const events: string[] = [];

    const result = await runInterruptibleAgreementBrowse({
      durationMs: 1_000,
      maxOverlayOccurrences: 3,
      now: () => now,
      browseOnce: async () => {
        browseCount += 1;
        events.push(`browse-${browseCount}`);
        now += 100;
        if (browseCount === 1) masked = true;
        return true;
      },
      isOverlayVisible: async () => masked,
      dismissOverlay: async () => {
        events.push('dismiss');
        now += 500;
        masked = false;
        return true;
      },
      wait: async (durationMs) => {
        now += durationMs;
      },
      nextPauseMs: () => 200,
    });

    expect(events.slice(0, 3)).toEqual(['browse-1', 'dismiss', 'browse-2']);
    expect(result.overlayDismissals).toBe(1);
    expect(result.browseConfirmed).toBe(true);
    expect(now).toBeGreaterThanOrEqual(1_500);
  });

  test('二次蒙版处理有总次数上限，不会无限重试', async () => {
    let dismissAttempts = 0;

    await expect(runInterruptibleAgreementBrowse({
      durationMs: 1_000,
      maxOverlayOccurrences: 3,
      now: () => 0,
      browseOnce: async () => false,
      isOverlayVisible: async () => true,
      dismissOverlay: async () => {
        dismissAttempts += 1;
        return true;
      },
      wait: async () => undefined,
      nextPauseMs: () => 200,
    })).rejects.toThrow('二次蒙版处理已达 3 次上限');

    expect(dismissAttempts).toBe(3);
  });
});
