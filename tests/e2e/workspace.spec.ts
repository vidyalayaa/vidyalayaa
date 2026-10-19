import { expect } from '@playwright/test';
import { test } from './fixtures/preview-app';
import AxeBuilder from '@axe-core/playwright';
test.use({ reducedMotion: 'reduce' });
test('setup workspace is honest, responsive and keyboard accessible', async ({ page }, info) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'A clearer view of your school.' })).toBeVisible();
  await expect(
    page.getByText('Workspace preview · setup required.', { exact: false }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: `tmp/qa/workspace-${info.project.name}.png`, fullPage: true });
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
});
test('navigation and empty resource views work', async ({ page }, info) => {
  await page.goto('/');
  if (info.project.name === 'mobile')
    await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('link', { name: 'Students', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Students', exact: true })).toBeVisible();
  await expect(page.getByText('Connect your school’s Supabase project and API')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add student', exact: true })).toBeDisabled();
});
test('login has labelled inputs and does not simulate authentication', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByLabel('Email address')).toBeVisible();
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeDisabled();
});
test('core setup screens have no serious or critical accessibility findings', async ({ page }) => {
  for (const path of ['/', '/login', '/attendance', '/r/students']) {
    await page.goto(path);
    await page.getByRole('heading', { level: 1 }).first().waitFor();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(
      results.violations.filter((v) => ['serious', 'critical'].includes(v.impact || '')),
    ).toEqual([]);
  }
});
