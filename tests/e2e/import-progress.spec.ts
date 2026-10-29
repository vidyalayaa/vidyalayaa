import { expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { test } from './fixtures/school-admin-app';

test.setTimeout(120000);
function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

test('teacher import shows real validation and saving stages and confirms the saved count', async ({
  page,
  authAppURL,
  platformApp,
}, testInfo) => {
  const validation = gate(),
    saving = gate();
  await page.route('**/api/v1/imports/teachers', async (route) => {
    await (route.request().postDataJSON().validate_only ? validation.wait : saving.wait);
    const response = await route.fetch({ url: platformApp.url + '/api/v1/imports/teachers' });
    await route.fulfill({ response });
  });
  try {
    await page.goto(authAppURL + '/admin/r/teachers');
    await page.getByRole('button', { name: 'Import CSV', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog
      .getByRole('textbox', { name: 'CSV preview', exact: true })
      .fill(
        'staff_code,full_name,account_email,status\nPROGRESS_01,Sample Teacher One,,ACTIVE\nPROGRESS_02,Sample Teacher Two,,ACTIVE',
      );
    const bar = dialog.getByRole('progressbar', { name: 'CSV import progress' });
    await dialog.getByRole('button', { name: 'Validate file', exact: true }).click();
    await expect(bar).toHaveAttribute('aria-valuetext', 'Validating 2 records…');
    await expect(bar).not.toHaveAttribute('aria-valuenow');
    await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeDisabled();
    await expect(dialog.getByRole('textbox', { name: 'CSV preview', exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    validation.release();
    await expect(bar).toHaveAttribute('aria-valuenow', '1');
    await expect(
      dialog.getByRole('button', { name: 'Import validated records', exact: true }),
    ).toBeEnabled();
    const f = platformApp.records;
    expect(
      (
        await platformApp.request(
          '/resources/teachers?search=PROGRESS_',
          'GET',
          undefined,
          f.admin,
          f.schoolA,
        )
      ).body.total,
    ).toBe(0);
    await dialog.getByRole('button', { name: 'Import validated records', exact: true }).click();
    await expect(bar).toHaveAttribute('aria-valuetext', 'Importing 2 records…');
    await expect(bar).not.toHaveAttribute('aria-valuenow');
    await expect(dialog.getByText('All rows validated. Ready to import.')).toHaveCount(0);
    const audit = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
    expect(
      audit.violations.filter((v) => ['serious', 'critical'].includes(v.impact || '')),
    ).toEqual([]);
    await page.screenshot({
      path: `tmp/qa/import-progress-${testInfo.project.name}.png`,
      fullPage: true,
    });
    saving.release();
    await expect(bar).toHaveAttribute('aria-valuenow', '2');
    await expect(bar).toHaveAttribute('aria-valuetext', 'Import complete. 2 records saved.');
    await expect(dialog.getByRole('status')).toContainText('2 records imported.');
    expect(
      (
        await platformApp.request(
          '/resources/teachers?search=PROGRESS_',
          'GET',
          undefined,
          f.admin,
          f.schoolA,
        )
      ).body.total,
    ).toBe(2);
    await dialog
      .getByRole('textbox', { name: 'CSV preview', exact: true })
      .fill('staff_code,full_name,account_email,status\nPROGRESS_03,Another Teacher,,ACTIVE');
    await expect(bar).toHaveCount(0);
    await expect(
      dialog.getByRole('button', { name: 'Import validated records', exact: true }),
    ).toBeDisabled();
  } finally {
    validation.release();
    saving.release();
  }
});

test('validation errors and unconfirmed commits never display a completed import', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  let dropResponse = true;
  const keys: string[] = [];
  await page.route('**/api/v1/imports/teachers', async (route) => {
    if (route.request().postDataJSON().validate_only) return route.fallback();
    keys.push(route.request().headers()['idempotency-key']);
    const response = await route.fetch({ url: platformApp.url + '/api/v1/imports/teachers' });
    if (dropResponse) {
      dropResponse = false;
      expect(response.status()).toBe(201);
      await route.abort('failed');
    } else await route.fulfill({ response });
  });
  await page.goto(authAppURL + '/admin/r/teachers');
  await page.getByRole('button', { name: 'Import CSV', exact: true }).click();
  const dialog = page.getByRole('dialog'),
    preview = dialog.getByRole('textbox', { name: 'CSV preview', exact: true });
  const bar = dialog.getByRole('progressbar', { name: 'CSV import progress' });
  await preview.fill(
    'staff_code,full_name,account_email,status\nPROGRESS_BAD,Invalid Teacher,,WRONG',
  );
  await dialog.getByRole('button', { name: 'Validate file', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(bar).toHaveAttribute('aria-valuenow', '0');
  await expect(
    dialog.getByRole('button', { name: 'Import validated records', exact: true }),
  ).toBeDisabled();
  await preview.fill(
    'staff_code,full_name,account_email,status\nPROGRESS_RETRY,Retry Teacher,,ACTIVE',
  );
  await dialog.getByRole('button', { name: 'Validate file', exact: true }).click();
  await expect(bar).toHaveAttribute('aria-valuenow', '1');
  const save = dialog.getByRole('button', { name: 'Import validated records', exact: true });
  await save.click();
  await expect(bar).toHaveAttribute(
    'aria-valuetext',
    'Import not confirmed. Review the error below before retrying.',
  );
  await expect(bar).toHaveAttribute('aria-valuenow', '1');
  await expect(save).toBeEnabled();
  await save.click();
  await expect(bar).toHaveAttribute('aria-valuenow', '2');
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  const f = platformApp.records;
  expect(
    (
      await platformApp.request(
        '/resources/teachers?search=PROGRESS_RETRY',
        'GET',
        undefined,
        f.admin,
        f.schoolA,
      )
    ).body.total,
  ).toBe(1);
});
