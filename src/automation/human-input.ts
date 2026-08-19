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

export interface HumanInputOptions {
  page: Page;
  seed: number;
  wait?: WaitFn;
  phoneErrorChance?: number;
  identityErrorChance?: number;
  identityMissingChance?: number;
}

function pauseRange(random: () => number): number {
  return randomInteger(random, 35, 115);
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
      await wait(randomInteger(random, 80, 220));
    }
    return;
  }

  if (strategy === 'pause-after-prefix') {
    const prefixLength = Math.max(1, Math.floor(value.length / 2));
    await locator.pressSequentially(value.slice(0, prefixLength), { delay: pauseRange(random) });
    await wait(randomInteger(random, 250, 650));
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
  await byTestId(page, inputTestId).click();

  const typeCharacter = async (character: string) => {
    await getKeyboardKey(page, character.toLowerCase() as KeyboardKey).click();
    await wait(randomInteger(random, 35, 120));
  };

  if (strategy === 'chunked') {
    const chunkSize = randomInteger(random, 2, 3);
    for (let index = 0; index < value.length; index += chunkSize) {
      for (const character of value.slice(index, index + chunkSize)) await typeCharacter(character);
      await wait(randomInteger(random, 80, 220));
    }
    return;
  }

  if (strategy === 'pause-after-prefix') {
    const prefixLength = Math.max(1, Math.floor(value.length / 2));
    for (const character of value.slice(0, prefixLength)) await typeCharacter(character);
    await wait(randomInteger(random, 250, 650));
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
  await wait(randomInteger(random, 120, 360));
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
    await getKeyboardKey(page, 'del').click();
    await wait(randomInteger(random, 30, 100));
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
    await getKeyboardKey(page, character.toLowerCase() as KeyboardKey).click();
    await wait(randomInteger(random, 35, 120));
  }
}

export async function fillPhone({
  page,
  value,
  seed,
  wait = defaultWait,
  errorChance = 0.2,
}: HumanInputOptions & { value: string; errorChance?: number }) {
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
  await wait(randomInteger(random, 250, 650));
  await focusVirtualInputAtEnd(page, LOCATORS.phoneInput);
  const mode = random() < 0.5 ? 'partial' : 'full';
  const deleteCount = mode === 'partial' ? value.length - wrong.index : value.length;
  await deleteIdentityCharacters(page, deleteCount, random, wait);
  const suffix = mode === 'partial' ? value.slice(wrong.index) : value;
  for (const character of suffix) {
    await getKeyboardKey(page, character as KeyboardKey).click();
    await wait(randomInteger(random, 35, 120));
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
  const random = createSeededRandom(seed + 37);
  const shouldOmit = chance(random, missingChance);
  const shouldError = !shouldOmit && chance(random, errorChance);

  if (shouldOmit) {
    await typeIdentityWithKeyboard(page, value.slice(0, -1), random, wait);
    await wait(randomInteger(random, 250, 650));
    await getKeyboardKey(page, value.at(-1)!.toLowerCase() as KeyboardKey).click();
    await closeKeyboardIfVisible(page);
    return { strategy: 'missing-input-corrected' as const, corrected: true };
  }

  if (shouldError) {
    const wrong = mutateValue(value, random);
    await typeIdentityWithKeyboard(page, wrong.value, random, wait);
    await closeKeyboardIfVisible(page);
    await wait(randomInteger(random, 250, 650));
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
