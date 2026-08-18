import type { Page } from '@playwright/test';
import type { KeyboardKey } from './types';

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

export function byTestId(page: Page, testId: LocatorTestId) {
  return page.getByTestId(testId);
}

export function getKeyboardKey(page: Page, key: KeyboardKey) {
  return page.getByTestId(key);
}
