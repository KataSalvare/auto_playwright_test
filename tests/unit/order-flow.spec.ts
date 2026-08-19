import { test, expect } from '@playwright/test';
import {
  chooseFirstOrderPreButtonPath,
  chooseRandomBrowseProfile,
  chooseRepeatOrderAgreementPath,
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
});
