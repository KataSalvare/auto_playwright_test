import type { Locator, Page } from '@playwright/test';

export type PageOrder = 1 | 2;
export type ProductChoice = 'basic' | 'upgrade';
export type BrowseProfile = 'skimmer' | 'reader' | 'distracted';
export type BrowserChannel = 'chrome' | 'msedge';
export type WaitFn = (durationMs: number) => Promise<void>;

export type KeyboardKey =
  | '0'
  | '1'
  | '2'
  | '3'
  | '4'
  | '5'
  | '6'
  | '7'
  | '8'
  | '9'
  | 'x'
  | 'del'
  | 'keyboard_close';

export interface OrderInput {
  orderId: string;
  phone: string;
  name: string;
  identityNumber: string;
  hasSocialSecurity: boolean;
  autoRenewal: boolean;
  pageOrder: PageOrder;
  sourceUrl: string;
  extraParams: Record<string, string>;
}

export interface AutomationOptions {
  seed: number;
  profile: BrowseProfile;
  product: ProductChoice;
  waitAgreement: boolean;
  waitProduct: boolean;
  headless: boolean;
  browserChannel?: BrowserChannel;
  deleteFailedVideo: boolean;
  outputDir: string;
  phoneErrorChance?: number;
  identityErrorChance?: number;
  identityMissingChance?: number;
}

export interface AutomationConfig {
  /** 是否使用无头浏览器；调试时改为 false。 */
  headless: boolean;
  /** 使用本机浏览器通道；留空时使用 Playwright 安装的 Chromium。 */
  browserChannel?: BrowserChannel;
  /** 未出现 success Toast 时是否删除失败视频。 */
  deleteFailedVideo: boolean;
  /** 视频输出目录。 */
  outputDir: string;
}

export interface HumanBrowseBehavior {
  pause(options?: { minMs?: number; maxMs?: number }): Promise<{ duration: number }>;
  scroll(options?: { allowBacktrack?: boolean }): Promise<{
    distance: number;
    duration: number;
    steps: number;
    backtracked: boolean;
  }>;
  scrollUntilVisible(locator: Locator, options?: { maxSwipes?: number }): Promise<{ swipes: number }>;
}

export interface HumanInputDependencies {
  page: Page;
  wait?: WaitFn;
}

export interface RunResult {
  orderId: string;
  pageOrder: PageOrder;
  success: boolean;
  videoPath?: string;
}
