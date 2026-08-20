import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fillIdentity, fillPhone } from '../../src/automation/human-input';
import { KEYBOARD_KEYS } from '../../src/automation/locators';

function createVirtualKeyboardPage(pageOptions: {
  keyboardVisible?: boolean;
  phoneConfirmationOnKeyboardClose?: boolean;
  phoneConfirmationOnPhoneComplete?: boolean;
} = {}) {
  const clicked: string[] = [];
  const inputClicks: Array<{ testId: string; position?: { x: number; y: number } }> = [];
  let overlayVisible = false;
  let phoneConfirmationVisible = false;
  let phoneDigitCount = 0;
  let phoneConfirmationTriggered = false;
  const page = {
    getByTestId: (testId: string) => ({
      click: async (options?: { position?: { x: number; y: number } }) => {
        if (testId === 'phone_input' && overlayVisible) {
          throw new Error('<div class="van-overlay"> intercepts pointer events');
        }
        clicked.push(testId);
        if (testId === 'keyboard_close' && pageOptions.phoneConfirmationOnKeyboardClose === true) {
          overlayVisible = true;
          phoneConfirmationVisible = true;
        }
        if (/^[0-9]$/.test(testId) && pageOptions.phoneConfirmationOnPhoneComplete === true) {
          phoneDigitCount += 1;
          if (phoneDigitCount === 11 && !phoneConfirmationTriggered) {
            overlayVisible = true;
            phoneConfirmationVisible = true;
            phoneConfirmationTriggered = true;
          }
        }
        if (testId === 'continue' && phoneConfirmationVisible) {
          overlayVisible = false;
          phoneConfirmationVisible = false;
        }
        if (testId === 'phone_input' || testId === 'idcard_input') {
          inputClicks.push({ testId, position: options?.position });
        }
      },
      isVisible: async () => (pageOptions.keyboardVisible === true && testId === 'keyboard_close')
        || phoneConfirmationVisible && testId === 'continue',
      boundingBox: async () => ({ x: 0, y: 0, width: 100, height: 40 }),
    }),
  } as unknown as Page;

  return { page, clicked, inputClicks };
}

function createStatefulIdentityPage() {
  let identityValue = '';
  const page = {
    getByTestId: (testId: string) => ({
      click: async () => {
        if (/^[0-9x]$/.test(testId)) identityValue += testId;
        if (testId === 'del') identityValue = identityValue.slice(0, -1);
      },
      isVisible: async () => false,
      boundingBox: async () => ({ x: 0, y: 0, width: 100, height: 40 }),
    }),
  } as unknown as Page;

  return {
    page,
    getIdentityValue: () => identityValue,
  };
}

test('身份证漏输导致 18 位校验失败后删除并完整重输', async () => {
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
  const deleteCount = keyboardClicks.filter((testId) => testId === 'del').length;
  expect(deleteCount).toBeGreaterThanOrEqual(1);
  expect(deleteCount).toBeLessThanOrEqual(18);
  const lastDeleteIndex = keyboardClicks.lastIndexOf('del');
  const correctedSuffix = keyboardClicks.slice(lastDeleteIndex + 1);
  expect(correctedSuffix).toEqual(identityNumber.slice(18 - deleteCount).split(''));
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
  const deleteCount = clicked.filter((testId) => testId === 'del').length;
  expect(deleteCount).toBeGreaterThanOrEqual(1);
  expect(deleteCount).toBeLessThanOrEqual(18);
  expect(inputClicks).toContainEqual({
    testId: 'idcard_input',
    position: { x: 98, y: 20 },
  });
});

test('手机号错误输入后从字段末尾开始删除修正', async () => {
  const { page, clicked, inputClicks } = createVirtualKeyboardPage({
    phoneConfirmationOnPhoneComplete: true,
  });

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

test('手机号错误输入后先同意关闭弹窗，再继续修正手机号', async () => {
  const { page, clicked } = createVirtualKeyboardPage({
    keyboardVisible: true,
    phoneConfirmationOnKeyboardClose: true,
  });

  await fillPhone({
    page,
    value: '15900000000',
    seed: 20260819,
    errorChance: 1,
    wait: async () => undefined,
  });

  const firstKeyboardCloseClick = clicked.indexOf('keyboard_close');
  const continueClick = clicked.indexOf('continue');
  const correctedPhoneInputClick = clicked.lastIndexOf('phone_input');
  expect(firstKeyboardCloseClick).toBeGreaterThanOrEqual(0);
  expect(continueClick).toBeGreaterThan(firstKeyboardCloseClick);
  expect(correctedPhoneInputClick).toBeGreaterThan(continueClick);
});

test('手机号输入第 11 位后自动弹窗时，先同意再修正手机号', async () => {
  const { page, clicked } = createVirtualKeyboardPage({
    phoneConfirmationOnPhoneComplete: true,
  });
  const waits: number[] = [];

  await fillPhone({
    page,
    value: '15900000000',
    seed: 20260819,
    errorChance: 1,
    wait: async (durationMs) => { waits.push(durationMs); },
  });

  const continueClick = clicked.indexOf('continue');
  const correctedPhoneInputClick = clicked.lastIndexOf('phone_input');
  expect(continueClick).toBeGreaterThanOrEqual(0);
  expect(correctedPhoneInputClick).toBeGreaterThan(continueClick);
  expect(waits.some((durationMs) => durationMs >= 2_000 && durationMs <= 3_000)).toBe(true);
  expect(waits.at(-1)).toBe(1_000);
});

test('身份证错误修正的多种删除位置最终都能得到正确值', async () => {
  const identityNumber = '320381198812252138';

  for (let seed = 1; seed <= 100; seed += 1) {
    const { page, getIdentityValue } = createStatefulIdentityPage();
    await fillIdentity({
      page,
      value: identityNumber,
      seed,
      inputStrategy: 'sequential',
      missingChance: 0,
      errorChance: 1,
      wait: async () => undefined,
    });
    expect(getIdentityValue(), `输错场景 seed=${seed}`).toBe(identityNumber);
  }

  for (let seed = 1; seed <= 100; seed += 1) {
    const { page, getIdentityValue } = createStatefulIdentityPage();
    await fillIdentity({
      page,
      value: identityNumber,
      seed,
      inputStrategy: 'sequential',
      missingChance: 1,
      errorChance: 0,
      wait: async () => undefined,
    });
    expect(getIdentityValue(), `漏输场景 seed=${seed}`).toBe(identityNumber);
  }
});
