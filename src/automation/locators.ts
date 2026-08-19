import type { Page } from '@playwright/test';
import type { KeyboardKey } from './types';

/** 页面约定的 jing-testid 映射，业务交互统一从这里取定位器。 */
export const LOCATORS = Object.freeze({
  phoneInput: 'phone_input',
  phoneContinue: 'continue',
  nameInput: 'name_input',
  identityInput: 'idcard_input',
  socialSecurityYes: 'shebao',
  socialSecurityNo: 'shebao_wu',
  renewalYes: 'xubao',
  renewalNo: 'xubao_wu',
  mainButton: 'denglu',
  agreementCheck: 'agreement_check',
  agreementContinue: 'agreement_continue',
  agreementClose: 'agreement_close',
  upgradeProduct: 'shengji',
  basicProduct: 'jichu',
  productClose: 'toubao_close',
  successToast: 'success',
} as const);

export const KEYBOARD_KEYS = Object.freeze([
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  'x',
  'del',
  'keyboard_close',
] as const satisfies readonly KeyboardKey[]);

export type LocatorTestId = (typeof LOCATORS)[keyof typeof LOCATORS] | KeyboardKey;

/**
 * 当前测试页把成功标记误作为 Vant Toast 文本输出，而不是 jing-testid 属性。
 * 保留测试 ID 为首选，仅对这个已确认的页面缺陷提供精确兼容。
 */
export const LEGACY_SUCCESS_TOAST_TEXT = 'jing-testid=success';

export function byTestId(page: Page, testId: LocatorTestId) {
  // Playwright 配置已将 testIdAttribute 设置为 jing-testid。
  return page.getByTestId(testId);
}

export function getKeyboardKey(page: Page, key: KeyboardKey) {
  // 键盘只接受白名单类型，避免拼接任意选择器。
  return page.getByTestId(key);
}

export function getSuccessToast(page: Page) {
  const testIdToast = byTestId(page, LOCATORS.successToast);
  const legacyTextToast = page
    .locator('.van-toast__text')
    .filter({ hasText: new RegExp(`^${LEGACY_SUCCESS_TOAST_TEXT}$`) });

  return testIdToast.or(legacyTextToast);
}
