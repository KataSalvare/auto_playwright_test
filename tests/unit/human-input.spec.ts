import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fillIdentity, fillPhone } from '../../src/automation/human-input';
import { KEYBOARD_KEYS } from '../../src/automation/locators';

function createVirtualKeyboardPage() {
  const clicked: string[] = [];
  const inputClicks: Array<{ testId: string; position?: { x: number; y: number } }> = [];
  const page = {
    getByTestId: (testId: string) => ({
      click: async (options?: { position?: { x: number; y: number } }) => {
        clicked.push(testId);
        if (testId === 'phone_input' || testId === 'idcard_input') {
          inputClicks.push({ testId, position: options?.position });
        }
      },
      isVisible: async () => false,
      boundingBox: async () => ({ x: 0, y: 0, width: 100, height: 40 }),
    }),
  } as unknown as Page;

  return { page, clicked, inputClicks };
}

test('身份证漏输修正只补齐末位，不误删已有数字', async () => {
  const { page, clicked } = createVirtualKeyboardPage();
  const identityNumber = '320381198812252138';

  const result = await fillIdentity({
    page,
    value: identityNumber,
    seed: 20260819,
    missingChance: 1,
    errorChance: 0,
    wait: async () => undefined,
  });

  const keyboardClicks = clicked.filter((testId) =>
    (KEYBOARD_KEYS as readonly string[]).includes(testId) && testId !== 'keyboard_close',
  );
  expect(result).toEqual({ strategy: 'missing-input-corrected', corrected: true });
  expect(keyboardClicks).toEqual(identityNumber.split(''));
  expect(keyboardClicks).not.toContain('del');
});

test('身份证错误输入后从字段末尾开始删除修正', async () => {
  const { page, clicked, inputClicks } = createVirtualKeyboardPage();

  const result = await fillIdentity({
    page,
    value: '320381198812252138',
    seed: 20260819,
    missingChance: 0,
    errorChance: 1,
    wait: async () => undefined,
  });

  expect(result).toEqual({ strategy: 'error-corrected', corrected: true });
  expect(clicked).toContain('del');
  expect(inputClicks.at(-1)).toEqual({
    testId: 'idcard_input',
    position: { x: 98, y: 20 },
  });
});

test('手机号错误输入后从字段末尾开始删除修正', async () => {
  const { page, clicked, inputClicks } = createVirtualKeyboardPage();

  const result = await fillPhone({
    page,
    value: '15900000000',
    seed: 20260819,
    errorChance: 1,
    wait: async () => undefined,
  });

  expect(result).toEqual({ strategy: 'error-corrected', corrected: true });
  expect(clicked).toContain('del');
  expect(inputClicks.at(-1)).toEqual({
    testId: 'phone_input',
    position: { x: 98, y: 20 },
  });
});
