import { test, expect } from '@playwright/test';

test.describe('smoke', () => {
  test('home page is reachable', async ({ page }) => {
    await page.goto('/');

    await expect(page).toHaveTitle(/Example Domain/);
    await expect(page.getByRole('heading', { name: 'Example Domain' })).toBeVisible();
  });
});
