import { test, expect } from '@playwright/test';
const enabled = !!process.env.E2E_EMAIL && !!process.env.E2E_PASSWORD && !!process.env.E2E_BASE_URL;
test('authenticated school workflow against staging services', async ({ page }) => {
  if (process.env.REQUIRE_LIVE_E2E && !enabled)
    throw new Error('Staging credentials and base URL are required for the release gate.');
  test.skip(!enabled, 'External Supabase/Render staging credentials are not configured.');
  await page.goto('/login');
  await page.getByLabel('Email address').fill(process.env.E2E_EMAIL!);
  await page.getByLabel('Password', { exact: true }).fill(process.env.E2E_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await page.goto('/attendance');
  await expect(page.getByRole('heading', { name: 'Every school day counts.' })).toBeVisible();
  await page.goto('/reports');
  await expect(page.getByRole('heading', { name: 'Turn records into perspective.' })).toBeVisible();
});
