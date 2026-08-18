import { test, expect } from '@playwright/test';
import {
  getKeyboardKey,
  getSuccessToast,
  KEYBOARD_KEYS,
  LEGACY_SUCCESS_TOAST_TEXT,
  LOCATORS,
} from '../../src/automation/locators';

test.describe('jing-testid 定位器', () => {
  test('业务定位器全部使用约定的打点值', () => {
    expect(LOCATORS).toEqual({
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
    });
  });

  test('键盘白名单包含数字、X、删除和完成', () => {
    expect(KEYBOARD_KEYS).toEqual([
      '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
      'x', 'del', 'keyboard_close',
    ]);
  });

  test('键盘定位器只接受白名单键类型', () => {
    const fakePage = {
      getByTestId: (testId: string) => ({ testId }),
    } as never;

    expect((getKeyboardKey(fakePage, '0') as never as { testId: string }).testId).toBe('0');
    expect((getKeyboardKey(fakePage, 'x') as never as { testId: string }).testId).toBe('x');
    expect((getKeyboardKey(fakePage, 'del') as never as { testId: string }).testId).toBe('del');
    expect((getKeyboardKey(fakePage, 'keyboard_close') as never as { testId: string }).testId).toBe('keyboard_close');
  });

  test('成功状态优先支持测试 ID', async ({ page }) => {
    await page.setContent('<div jing-testid="success">成功</div>');
    await expect(getSuccessToast(page)).toBeVisible();
  });

  test('兼容真实页面误输出的成功 Toast 文本', async ({ page }) => {
    await page.setContent(`<div class="van-toast__text">${LEGACY_SUCCESS_TOAST_TEXT}</div>`);
    await expect(getSuccessToast(page)).toBeVisible();
  });
});
