import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright test configuration.
 *
 * Set BASE_URL to the system under test before running the suite, for example:
 * BASE_URL=https://staging.example.com npm test
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.BASE_URL ?? 'https://example.com',
    // 默认使用 Playwright 的 headless shell；只有显式设置 PW_CHANNEL 时才使用品牌浏览器。
    channel: process.env.PW_CHANNEL || undefined,
    testIdAttribute: 'jing-testid',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  outputDir: 'test-results',
});
