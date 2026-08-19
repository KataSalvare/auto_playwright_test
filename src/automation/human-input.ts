import type { Locator, Page } from '@playwright/test';
import { byTestId, getKeyboardKey, LOCATORS } from './locators';
import type { LocatorTestId } from './locators';
import { chance, createSeededRandom, pick, randomInteger } from './random';
import type { KeyboardKey, WaitFn } from './types';

const defaultWait: WaitFn = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs));

const INPUT_STRATEGIES = Object.freeze([
  'sequential',
  'chunked',
  'variable',
  'pause-after-prefix',
  'slow-tail',
] as const);

export type InputStrategy = (typeof INPUT_STRATEGIES)[number];

// 按 40–70 岁用户的操作节奏模拟：单个字符更慢，分段输入时增加思考停顿。
const MATURE_USER_TIMING = Object.freeze({
  characterMinMs: 180,
  characterMaxMs: 420,
  shortPauseMinMs: 320,
  shortPauseMaxMs: 820,
  thinkingPauseMinMs: 650,
  thinkingPauseMaxMs: 1_400,
  deleteMinMs: 120,
  deleteMaxMs: 300,
});
const KEYBOARD_PRESS_HOLD_MS = 90;

export interface HumanInputOptions {
  page: Page;
  seed: number;
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

async function clickKeyboardKey(page: Page, key: KeyboardKey) {
  // 保持按下约 90ms，让键盘的 pointerdown/active 动画被录像采集到。
  await getKeyboardKey(page, key).click({ delay: KEYBOARD_PRESS_HOLD_MS });
}

function mutateValue(value: string, random: () => number): { value: string; index: number } {
  const index = randomInteger(random, 0, value.length - 1);
  const original = value[index];
  const replacement = original.toUpperCase() === 'X'
    ? '0'
    : String((Number(original) + randomInteger(random, 1, 9)) % 10);
  return { value: `${value.slice(0, index)}${replacement}${value.slice(index + 1)}`, index };
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

async function closeKeyboardIfVisible(page: Page) {
  const close = getKeyboardKey(page, 'keyboard_close');
  if (await close.isVisible().catch(() => false)) {
    await close.click({ timeout: 1_500 }).catch(() => undefined);
  }
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
) {
  // 手机号和身份证通过页面自定义数字键盘输入，避免直接 fill 绕过真实交互。
  await byTestId(page, inputTestId).click();

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
  random: () => number,
  wait: WaitFn,
) {
  await locator.click();
  await pressSequentially(locator, value, pick(random, INPUT_STRATEGIES), wait, random);
}

async function typeIdentityWithKeyboard(
  page: Page,
  value: string,
  random: () => number,
  wait: WaitFn,
) {
  await typeWithVirtualKeyboard(
    page,
    LOCATORS.identityInput,
    value,
    pick(random, INPUT_STRATEGIES),
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
  wrongIndex: number,
  mode: 'partial' | 'full',
  random: () => number,
  wait: WaitFn,
) {
  await focusVirtualInputAtEnd(page, LOCATORS.identityInput);
  await deleteIdentityCharacters(page, expected.length - (mode === 'partial' ? wrongIndex : 0), random, wait);
  const suffix = mode === 'partial' ? expected.slice(wrongIndex) : expected;
  for (const character of suffix) {
    await clickKeyboardKey(page, character.toLowerCase() as KeyboardKey);
    await wait(pauseRange(random));
  }
}

export async function fillPhone({
  page,
  value,
  seed,
  wait = defaultWait,
  errorChance = 0.2,
}: HumanInputOptions & { value: string; errorChance?: number }) {
  // 按随机策略输入手机号；错误分支会删除后从字段末尾纠正。
  const random = createSeededRandom(seed + 11);

  if (!chance(random, errorChance)) {
    await typeWithVirtualKeyboard(
      page,
      LOCATORS.phoneInput,
      value,
      pick(random, INPUT_STRATEGIES),
      random,
      wait,
    );
    await closeKeyboardIfVisible(page);
    return { strategy: 'correct' as const, corrected: false };
  }

  const wrong = mutateValue(value, random);
  await typeWithVirtualKeyboard(page, LOCATORS.phoneInput, wrong.value, pick(random, INPUT_STRATEGIES), random, wait);
  await closeKeyboardIfVisible(page);
  await wait(thinkingPause(random));
  await focusVirtualInputAtEnd(page, LOCATORS.phoneInput);
  const mode = random() < 0.5 ? 'partial' : 'full';
  const deleteCount = mode === 'partial' ? value.length - wrong.index : value.length;
  await deleteIdentityCharacters(page, deleteCount, random, wait);
  const suffix = mode === 'partial' ? value.slice(wrong.index) : value;
  for (const character of suffix) {
    await clickKeyboardKey(page, character as KeyboardKey);
    await wait(pauseRange(random));
  }
  await closeKeyboardIfVisible(page);
  return { strategy: 'error-corrected' as const, corrected: true };
}

export async function fillName({
  page,
  value,
  seed,
  wait = defaultWait,
}: HumanInputOptions & { value: string }) {
  const random = createSeededRandom(seed + 23);
  await fillNativeValue(byTestId(page, LOCATORS.nameInput), value, random, wait);
  await closeKeyboardIfVisible(page);
  return { strategyCount: INPUT_STRATEGIES.length };
}

export async function fillIdentity({
  page,
  value,
  seed,
  wait = defaultWait,
  errorChance = 0.25,
  missingChance = 0.1,
}: HumanInputOptions & { value: string; errorChance?: number; missingChance?: number }) {
  // 身份证支持正常输入、漏输补齐和错误删除重输三种路径。
  const random = createSeededRandom(seed + 37);
  const shouldOmit = chance(random, missingChance);
  const shouldError = !shouldOmit && chance(random, errorChance);

  if (shouldOmit) {
    await typeIdentityWithKeyboard(page, value.slice(0, -1), random, wait);
    await wait(thinkingPause(random));
    await clickKeyboardKey(page, value.at(-1)!.toLowerCase() as KeyboardKey);
    await closeKeyboardIfVisible(page);
    return { strategy: 'missing-input-corrected' as const, corrected: true };
  }

  if (shouldError) {
    const wrong = mutateValue(value, random);
    await typeIdentityWithKeyboard(page, wrong.value, random, wait);
    await closeKeyboardIfVisible(page);
    await wait(thinkingPause(random));
    await correctIdentityWithKeyboard(
      page,
      value,
      wrong.index,
      random() < 0.5 ? 'partial' : 'full',
      random,
      wait,
    );
    await closeKeyboardIfVisible(page);
    return { strategy: 'error-corrected' as const, corrected: true };
  }

  await typeIdentityWithKeyboard(page, value, random, wait);
  await closeKeyboardIfVisible(page);
  return { strategy: 'correct' as const, corrected: false };
}

export { INPUT_STRATEGIES };
