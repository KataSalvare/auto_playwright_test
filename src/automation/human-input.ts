import type { Locator, Page } from '@playwright/test';
import { hasValidIdentityChecksum } from './identity';
import { byTestId, getKeyboardKey, LOCATORS } from './locators';
import type { LocatorTestId } from './locators';
import { chance, createSeededRandom, pick, randomInteger } from './random';
import type { InputStrategy, KeyboardKey, WaitFn } from './types';

const defaultWait: WaitFn = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs));

const INPUT_STRATEGIES = Object.freeze([
  'sequential',
  'chunked',
  'variable',
  'pause-after-prefix',
  'slow-tail',
] as const);

export type { InputStrategy } from './types';

// 按 40–70 岁用户的操作节奏模拟：单个字符更慢，分段输入时增加思考停顿。
const MATURE_USER_TIMING = Object.freeze({
  characterMinMs: 180,
  characterMaxMs: 420,
  shortPauseMinMs: 320,
  shortPauseMaxMs: 820,
  thinkingPauseMinMs: 650,
  thinkingPauseMaxMs: 1_400,
  deleteMinMs: 60,
  deleteMaxMs: 160,
});
const KEYBOARD_PRESS_HOLD_MS = 90;
const KEYBOARD_DELETE_PRESS_HOLD_MS = 45;
const VIRTUAL_INPUT_FOCUS_WAIT_MIN_MS = 1_000;
const VIRTUAL_INPUT_FOCUS_WAIT_MAX_MS = 3_000;
const NAME_INPUT_FOCUS_WAIT_MIN_MS = 2_000;
const NAME_INPUT_FOCUS_WAIT_MAX_MS = 5_000;
const NAME_CHARACTER_MIN_MS = 450;
const NAME_CHARACTER_MAX_MS = 900;
const NAME_THINKING_PAUSE_MIN_MS = 800;
const NAME_THINKING_PAUSE_MAX_MS = 1_800;
const IDENTITY_VALIDATION_WAIT_MIN_MS = 1_000;
const IDENTITY_VALIDATION_WAIT_MAX_MS = 2_000;

export interface HumanInputOptions {
  page: Page;
  seed: number;
  inputStrategy?: InputStrategy;
  wait?: WaitFn;
  phoneErrorChance?: number;
  identityErrorChance?: number;
  identityMissingChance?: number;
}

function pauseRange(random: () => number): number {
  return randomInteger(
    random,
    MATURE_USER_TIMING.characterMinMs,
    MATURE_USER_TIMING.characterMaxMs,
  );
}

function shortPause(random: () => number): number {
  return randomInteger(
    random,
    MATURE_USER_TIMING.shortPauseMinMs,
    MATURE_USER_TIMING.shortPauseMaxMs,
  );
}

function thinkingPause(random: () => number): number {
  return randomInteger(
    random,
    MATURE_USER_TIMING.thinkingPauseMinMs,
    MATURE_USER_TIMING.thinkingPauseMaxMs,
  );
}

function inputFocusPause(random: () => number, minMs: number, maxMs: number): number {
  return randomInteger(random, minMs, maxMs);
}

function namePauseRange(random: () => number): number {
  return randomInteger(random, NAME_CHARACTER_MIN_MS, NAME_CHARACTER_MAX_MS);
}

function ensureInvalidIdentity(identityNumber: string): string {
  if (!hasValidIdentityChecksum(identityNumber)) return identityNumber;

  const currentLastCharacter = identityNumber.at(-1)!.toUpperCase();
  const alternatives = [...'0123456789X'].filter((character) => character !== currentLastCharacter);
  for (const character of alternatives) {
    const candidate = `${identityNumber.slice(0, -1)}${character}`;
    if (!hasValidIdentityChecksum(candidate)) return candidate;
  }

  throw new Error('无法构造身份证校验失败的测试输入');
}

function createMissingIdentity(value: string, random: () => number): { value: string; errorIndex: number } {
  const omittedIndex = randomInteger(random, 0, value.length - 2);
  const withoutCharacter = `${value.slice(0, omittedIndex)}${value.slice(omittedIndex + 1)}`;
  const extraCharacter = String(randomInteger(random, 0, 9));
  return {
    value: ensureInvalidIdentity(`${withoutCharacter}${extraCharacter}`),
    errorIndex: omittedIndex,
  };
}

function chooseIdentityCorrectionStart(errorIndex: number, random: () => number): number {
  // 一部分用户会多删一到三位后，直接从当前光标位置继续输入正确后缀。
  if (errorIndex <= 0 || random() < 0.5) return 0;
  return Math.max(0, errorIndex - randomInteger(random, 1, Math.min(3, errorIndex)));
}

async function clickKeyboardKey(page: Page, key: KeyboardKey) {
  // 删除键使用更短按压，模拟用户连续快速删除；其他键保留动画可见时长。
  const delay = key === 'del' ? KEYBOARD_DELETE_PRESS_HOLD_MS : KEYBOARD_PRESS_HOLD_MS;
  await getKeyboardKey(page, key).click({ delay });
}

function mutateValue(
  value: string,
  random: () => number,
  minIndex = 0,
): { value: string; index: number } {
  const index = randomInteger(random, minIndex, value.length - 1);
  const original = value[index];
  const replacement = original.toUpperCase() === 'X'
    ? '0'
    : String((Number(original) + randomInteger(random, 1, 9)) % 10);
  return { value: `${value.slice(0, index)}${replacement}${value.slice(index + 1)}`, index };
}

/** 手机号前两位固定正确，只允许在后 9 位制造错误。 */
export function mutatePhoneValue(value: string, random: () => number): { value: string; index: number } {
  if (value.length < 3) throw new Error('手机号至少需要 3 位才能保留前两位正确');
  return mutateValue(value, random, 2);
}

async function pressSequentially(locator: Locator, value: string, strategy: InputStrategy, wait: WaitFn, random: () => number) {
  if (strategy === 'sequential') {
    await locator.pressSequentially(value, { delay: pauseRange(random) });
    return;
  }

  if (strategy === 'chunked') {
    const chunkSize = randomInteger(random, 2, 3);
    for (let index = 0; index < value.length; index += chunkSize) {
      await locator.pressSequentially(value.slice(index, index + chunkSize), { delay: pauseRange(random) });
      await wait(shortPause(random));
    }
    return;
  }

  if (strategy === 'pause-after-prefix') {
    const prefixLength = Math.max(1, Math.floor(value.length / 2));
    await locator.pressSequentially(value.slice(0, prefixLength), { delay: pauseRange(random) });
    await wait(thinkingPause(random));
    await locator.pressSequentially(value.slice(prefixLength), { delay: pauseRange(random) });
    return;
  }

  const slowTailStart = Math.max(1, value.length - 3);
  for (let index = 0; index < value.length; index += 1) {
    await locator.pressSequentially(value[index], {
      delay: index >= slowTailStart ? pauseRange(random) + 45 : pauseRange(random),
    });
    if (strategy === 'variable' || index === slowTailStart - 1) await wait(pauseRange(random));
  }
}

async function pressNameSequentially(locator: Locator, value: string, strategy: InputStrategy, wait: WaitFn, random: () => number) {
  if (strategy === 'sequential') {
    await locator.pressSequentially(value, { delay: namePauseRange(random) });
    return;
  }

  if (strategy === 'chunked') {
    const chunkSize = randomInteger(random, 2, 3);
    for (let index = 0; index < value.length; index += chunkSize) {
      await locator.pressSequentially(value.slice(index, index + chunkSize), { delay: namePauseRange(random) });
      await wait(randomInteger(random, NAME_THINKING_PAUSE_MIN_MS, NAME_THINKING_PAUSE_MAX_MS));
    }
    return;
  }

  if (strategy === 'pause-after-prefix') {
    const prefixLength = Math.max(1, Math.floor(value.length / 2));
    await locator.pressSequentially(value.slice(0, prefixLength), { delay: namePauseRange(random) });
    await wait(randomInteger(random, NAME_THINKING_PAUSE_MIN_MS, NAME_THINKING_PAUSE_MAX_MS));
    await locator.pressSequentially(value.slice(prefixLength), { delay: namePauseRange(random) });
    return;
  }

  const slowTailStart = Math.max(1, value.length - 1);
  for (let index = 0; index < value.length; index += 1) {
    await locator.pressSequentially(value[index], {
      delay: namePauseRange(random) + (index >= slowTailStart ? 100 : 0),
    });
    if (strategy === 'variable' || index === slowTailStart - 1) {
      await wait(randomInteger(random, NAME_THINKING_PAUSE_MIN_MS, NAME_THINKING_PAUSE_MAX_MS));
    }
  }
}

async function closeKeyboardIfVisible(page: Page): Promise<boolean> {
  const close = getKeyboardKey(page, 'keyboard_close');
  if (!(await close.isVisible().catch(() => false))) return false;
  await close.click({ timeout: 1_500 }).catch(() => undefined);
  return true;
}

/**
 * 错误手机号达到 11 位并收起键盘后，页面会先弹出手机号确认层。
 * 先同意关闭该弹窗，才能重新聚焦手机号输入框进行修正。
 */
async function clickPhoneConfirmationIfVisible(
  page: Page,
  wait: WaitFn,
  random: () => number,
  timeoutMs = 5_000,
) {
  const continueButton = byTestId(page, LOCATORS.phoneContinue);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await continueButton.isVisible().catch(() => false)) {
      // 按原本步骤 2 的真人化节奏，弹窗出现后先停顿 1–2 秒再点击。
      await wait(randomInteger(random, 1_000, 2_000));
      try {
        await continueButton.click({ timeout: 5_000 });
      } catch {
        // 弹窗刚完成动画时，普通点击可能被蒙层拦截；按钮仍在弹窗内，可安全重试 force click。
        await continueButton.click({ timeout: 5_000, force: true });
      }
      return true;
    }
    await wait(100);
  }

  return false;
}

async function focusVirtualInputAtEnd(page: Page, inputTestId: LocatorTestId) {
  // 自定义键盘输入框不是原生 input，重新聚焦时点击最右侧才能把光标放到末尾。
  const input = byTestId(page, inputTestId);
  const box = await input.boundingBox().catch(() => null);
  if (!box) {
    await input.click();
    return;
  }

  await input.click({
    position: {
      x: Math.max(1, box.width - 2),
      y: Math.max(1, box.height / 2),
    },
  });
}

async function clearNativeInput(locator: Locator) {
  await locator.press('ControlOrMeta+A');
  await locator.press('Backspace');
}

async function typeWithVirtualKeyboard(
  page: Page,
  inputTestId: LocatorTestId,
  value: string,
  strategy: InputStrategy,
  random: () => number,
  wait: WaitFn,
  focusInput = true,
) {
  // 手机号和身份证通过页面自定义数字键盘输入，避免直接 fill 绕过真实交互。
  if (focusInput) {
    await byTestId(page, inputTestId).click();
    // 模拟用户点击输入框后先观察键盘和页面状态，再开始输入。
    await wait(inputFocusPause(
      random,
      VIRTUAL_INPUT_FOCUS_WAIT_MIN_MS,
      VIRTUAL_INPUT_FOCUS_WAIT_MAX_MS,
    ));
  }

  const typeCharacter = async (character: string) => {
    await clickKeyboardKey(page, character.toLowerCase() as KeyboardKey);
    await wait(pauseRange(random));
  };

  if (strategy === 'chunked') {
    const chunkSize = randomInteger(random, 2, 3);
    for (let index = 0; index < value.length; index += chunkSize) {
      for (const character of value.slice(index, index + chunkSize)) await typeCharacter(character);
      await wait(shortPause(random));
    }
    return;
  }

  if (strategy === 'pause-after-prefix') {
    const prefixLength = Math.max(1, Math.floor(value.length / 2));
    for (const character of value.slice(0, prefixLength)) await typeCharacter(character);
    await wait(thinkingPause(random));
    for (const character of value.slice(prefixLength)) await typeCharacter(character);
    return;
  }

  const slowTailStart = Math.max(1, value.length - 3);
  for (let index = 0; index < value.length; index += 1) {
    await typeCharacter(value[index]);
    if (strategy === 'variable' || index === slowTailStart - 1) {
      await wait(pauseRange(random) + (index >= slowTailStart ? 45 : 0));
    }
  }
}

async function correctNativeInput(
  locator: Locator,
  expected: string,
  wrongIndex: number,
  mode: 'partial' | 'full',
  wait: WaitFn,
  random: () => number,
) {
  if (mode === 'full') {
    await clearNativeInput(locator);
    await pressSequentially(locator, expected, pick(random, INPUT_STRATEGIES), wait, random);
    return;
  }

  await locator.press('End');
  for (let index = wrongIndex; index < expected.length; index += 1) await locator.press('Backspace');
  await wait(shortPause(random));
  await pressSequentially(locator, expected.slice(wrongIndex), pick(random, INPUT_STRATEGIES), wait, random);
}

async function fillNativeValue(
  locator: Locator,
  value: string,
  strategy: InputStrategy,
  random: () => number,
  wait: WaitFn,
) {
  await locator.click();
  // 姓名输入框点击后等待更久，模拟用户确认焦点和键盘状态。
  await wait(inputFocusPause(
    random,
    NAME_INPUT_FOCUS_WAIT_MIN_MS,
    NAME_INPUT_FOCUS_WAIT_MAX_MS,
  ));
  await pressNameSequentially(locator, value, strategy, wait, random);
}

async function typeIdentityWithKeyboard(
  page: Page,
  value: string,
  strategy: InputStrategy,
  random: () => number,
  wait: WaitFn,
) {
  await typeWithVirtualKeyboard(
    page,
    LOCATORS.identityInput,
    value,
    strategy,
    random,
    wait,
  );
}

async function deleteIdentityCharacters(page: Page, count: number, random: () => number, wait: WaitFn) {
  for (let index = 0; index < count; index += 1) {
    await clickKeyboardKey(page, 'del');
    await wait(randomInteger(
      random,
      MATURE_USER_TIMING.deleteMinMs,
      MATURE_USER_TIMING.deleteMaxMs,
    ));
  }
}

async function correctIdentityWithKeyboard(
  page: Page,
  expected: string,
  strategy: InputStrategy,
  correctionStart: number,
  random: () => number,
  wait: WaitFn,
) {
  await focusVirtualInputAtEnd(page, LOCATORS.identityInput);
  await wait(inputFocusPause(
    random,
    VIRTUAL_INPUT_FOCUS_WAIT_MIN_MS,
    VIRTUAL_INPUT_FOCUS_WAIT_MAX_MS,
  ));
  // 校验失败后，部分用户会多删几位，再从当前光标位置直接输入正确后缀。
  await deleteIdentityCharacters(page, expected.length - correctionStart, random, wait);
  // 删除完成后用户会短暂停顿确认内容；不重新点击输入框，保持当前键盘焦点。
  await wait(inputFocusPause(
    random,
    VIRTUAL_INPUT_FOCUS_WAIT_MIN_MS,
    VIRTUAL_INPUT_FOCUS_WAIT_MAX_MS,
  ));
  // 删除键不会关闭自定义键盘，等待结束后直接输入新的正确后缀。
  await typeWithVirtualKeyboard(
    page,
    LOCATORS.identityInput,
    expected.slice(correctionStart),
    strategy,
    random,
    wait,
    false,
  );
}

export async function fillPhone({
  page,
  value,
  seed,
  inputStrategy,
  wait = defaultWait,
  errorChance = 0.2,
}: HumanInputOptions & { value: string; errorChance?: number }) {
  // 按随机策略输入手机号；错误分支会删除后从字段末尾纠正。
  const random = createSeededRandom(seed + 11);
  const strategy = inputStrategy ?? pick(random, INPUT_STRATEGIES);

  if (!chance(random, errorChance)) {
    await typeWithVirtualKeyboard(
      page,
      LOCATORS.phoneInput,
      value,
      strategy,
      random,
      wait,
    );
    await closeKeyboardIfVisible(page);
    return { strategy: 'correct' as const, corrected: false };
  }

  const wrong = mutatePhoneValue(value, random);
  await typeWithVirtualKeyboard(page, LOCATORS.phoneInput, wrong.value, strategy, random, wait);
  await closeKeyboardIfVisible(page);
  // 错误手机号必须先确认，确认后页面已经进入实名区域，再等待原逻辑的 2–3 秒。
  const confirmationHandled = await clickPhoneConfirmationIfVisible(page, wait, random);
  if (!confirmationHandled) {
    throw new Error('错误手机号输入后未找到手机号确认弹窗的同意并继续按钮');
  }
  await wait(randomInteger(random, 2_000, 3_000));
  await focusVirtualInputAtEnd(page, LOCATORS.phoneInput);
  await wait(inputFocusPause(
    random,
    VIRTUAL_INPUT_FOCUS_WAIT_MIN_MS,
    VIRTUAL_INPUT_FOCUS_WAIT_MAX_MS,
  ));
  const mode = random() < 0.5 ? 'partial' : 'full';
  const deleteCount = mode === 'partial' ? value.length - wrong.index : value.length;
  await deleteIdentityCharacters(page, deleteCount, random, wait);
  const suffix = mode === 'partial' ? value.slice(wrong.index) : value;
  for (const character of suffix) {
    await clickKeyboardKey(page, character as KeyboardKey);
    await wait(pauseRange(random));
  }
  await closeKeyboardIfVisible(page);
  // 手机号修正完成后，停顿 1 秒再交给外层点击姓名输入框。
  await wait(1_000);
  return { strategy: 'error-corrected' as const, corrected: true };
}

export async function fillName({
  page,
  value,
  seed,
  inputStrategy,
  wait = defaultWait,
}: HumanInputOptions & { value: string }) {
  const random = createSeededRandom(seed + 23);
  const strategy = inputStrategy ?? pick(random, INPUT_STRATEGIES);
  await fillNativeValue(byTestId(page, LOCATORS.nameInput), value, strategy, random, wait);
  await closeKeyboardIfVisible(page);
  return { strategyCount: INPUT_STRATEGIES.length };
}

export async function fillIdentity({
  page,
  value,
  seed,
  inputStrategy,
  wait = defaultWait,
  errorChance = 0.25,
  missingChance = 0.1,
}: HumanInputOptions & { value: string; errorChance?: number; missingChance?: number }) {
  // 身份证支持正常输入、漏输补齐和错误删除重输三种路径。
  const random = createSeededRandom(seed + 37);
  const strategy = inputStrategy ?? pick(random, INPUT_STRATEGIES);
  const shouldOmit = chance(random, missingChance);
  const shouldError = !shouldOmit && chance(random, errorChance);

  if (shouldOmit) {
    // 漏输一位后继续输入到 18 位，最终形成校验失败的完整号码。
    const missing = createMissingIdentity(value, random);
    await typeIdentityWithKeyboard(page, missing.value, strategy, random, wait);
    await closeKeyboardIfVisible(page);
    await wait(inputFocusPause(random, IDENTITY_VALIDATION_WAIT_MIN_MS, IDENTITY_VALIDATION_WAIT_MAX_MS));
    await correctIdentityWithKeyboard(
      page,
      value,
      strategy,
      chooseIdentityCorrectionStart(missing.errorIndex, random),
      random,
      wait,
    );
    await closeKeyboardIfVisible(page);
    return { strategy: 'missing-input-corrected' as const, corrected: true };
  }

  if (shouldError) {
    const wrong = mutateValue(value, random);
    await typeIdentityWithKeyboard(page, ensureInvalidIdentity(wrong.value), strategy, random, wait);
    await closeKeyboardIfVisible(page);
    await wait(inputFocusPause(random, IDENTITY_VALIDATION_WAIT_MIN_MS, IDENTITY_VALIDATION_WAIT_MAX_MS));
    await correctIdentityWithKeyboard(
      page,
      value,
      strategy,
      chooseIdentityCorrectionStart(wrong.index, random),
      random,
      wait,
    );
    await closeKeyboardIfVisible(page);
    return { strategy: 'error-corrected' as const, corrected: true };
  }

  await typeIdentityWithKeyboard(page, value, strategy, random, wait);
  await closeKeyboardIfVisible(page);
  return { strategy: 'correct' as const, corrected: false };
}

export { INPUT_STRATEGIES };
