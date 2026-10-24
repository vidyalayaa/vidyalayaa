import { expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { test } from './fixtures/school-admin-app';
test.setTimeout(120000);
test('School Admin selects members, confirms a custom message, cancels it and saves alert controls', async ({
  page,
  authAppURL,
  platformApp,
}, info) => {
  await page.goto(authAppURL + '/admin/notifications');
  await expect(page.getByRole('heading', { name: 'Notifications', exact: true })).toBeVisible({
    timeout: 30000,
  });
  await page.getByRole('button', { name: 'Send notification', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Title', exact: true })
    .fill('Diary reminder ' + info.project.name);
  await page
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill('Bring your diary tomorrow.');
  await page
    .getByRole('textbox', { name: 'Find members', exact: true })
    .fill(platformApp.records.parent + '@');
  const parent = page.getByRole('checkbox').first();
  await expect(parent).toBeVisible();
  await parent.check();
  await page.getByRole('button', { name: 'Review recipients' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('1 recipient(s)');
  await expect(dialog).toContainText('0 with push enabled');
  const axe = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
  expect(axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact || ''))).toEqual(
    [],
  );
  await dialog.getByRole('button', { name: 'Queue notification' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Diary reminder ' + info.project.name }),
  ).toBeVisible();
  const item = page.locator('article').filter({ hasText: 'Diary reminder ' + info.project.name });
  await item.getByRole('button', { name: 'Cancel queued' }).click();
  await page
    .getByRole('dialog')
    .getByRole('textbox', { name: 'Reason' })
    .fill('Schedule changed; cancel reminder');
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(item).toContainText('CANCELLED');
  await page.getByRole('button', { name: 'Automatic alerts' }).click();
  await page.getByRole('checkbox', { name: 'Enable school notifications', exact: true }).uncheck();
  await page.getByRole('button', { name: 'Save alert settings' }).click();
  await expect(page.getByRole('status')).toContainText('School notification settings saved.');
  await page.reload();
  await page.getByRole('button', { name: 'Automatic alerts' }).click();
  await expect(
    page.getByRole('checkbox', { name: 'Enable school notifications', exact: true }),
  ).not.toBeChecked();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
test('School Admin can preview an entire role and clear individual selections', async ({
  page,
  authAppURL,
}) => {
  await page.goto(authAppURL + '/admin/notifications');
  await page.getByRole('button', { name: 'Send notification', exact: true }).click();
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Parent meeting');
  await page
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill('A new parent meeting has been arranged.');
  await page.getByRole('combobox', { name: 'Send to', exact: true }).selectOption('ROLES');
  await page.getByRole('checkbox', { name: 'Parent', exact: true }).check();
  await page.getByRole('button', { name: 'Review recipients' }).click();
  await expect(page.getByRole('dialog')).toContainText('1 recipient(s)');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('combobox', { name: 'Send to', exact: true }).selectOption('ALL');
  await page.getByRole('button', { name: 'Review recipients' }).click();
  await expect(page.getByRole('dialog')).toContainText('5 recipient(s)');
});
