import { expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { test } from './fixtures/school-admin-app';
test.setTimeout(120000);
test('School Admin configures class fees, assesses a student, records and reverses payment, prints and exports', async ({
  page,
  authAppURL,
  platformApp,
}, testInfo) => {
  const f = platformApp.records;
  await page.goto(authAppURL + '/admin/r/fee_records');
  await expect(page.getByRole('heading', { name: 'Fees, clearly accounted for.' })).toBeVisible({
    timeout: 30000,
  });
  await page.getByRole('combobox', { name: 'Academic year', exact: true }).selectOption(f.session);
  await page.getByRole('combobox', { name: 'Class', exact: true }).selectOption('8');
  await page.getByRole('combobox', { name: 'Section', exact: true }).selectOption(f.classId);
  await page.getByRole('combobox', { name: 'Student', exact: true }).selectOption(f.student);
  await page.getByRole('button', { name: 'Class fee structures', exact: true }).click();
  await page.getByRole('button', { name: 'Configure fees', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Add fee category', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Fee label', exact: true }).fill('Browser tuition');
  await dialog
    .getByRole('spinbutton', { name: 'Amount per installment (INR)', exact: true })
    .fill('100');
  await dialog.getByRole('combobox', { name: 'Schedule', exact: true }).selectOption('ONE_TIME');
  await dialog.getByLabel('First due date', { exact: true }).fill('2026-01-01');
  await dialog.getByRole('button', { name: 'Save new version', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  page.on('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Preview & assess fees', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('1 installments assessed');
  await page.getByRole('button', { name: 'Student fees', exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: 'Browser tuition' });
  await expect(row).toContainText('₹100.00');
  await page.getByRole('button', { name: 'Record payment', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('spinbutton', { name: /Amount for Browser tuition/ }).fill('40');
  await dialog
    .getByRole('textbox', { name: 'Remarks / notes', exact: true })
    .fill('Verified browser payment');
  await dialog
    .getByRole('textbox', { name: /^Receipt number/ })
    .fill('BROWSER-REC-' + testInfo.project.name);
  await dialog.getByRole('combobox', { name: 'Payment method', exact: true }).selectOption('UPI');
  await dialog
    .getByRole('textbox', { name: 'Transaction / reference number', exact: true })
    .fill('BROWSER-UPI-123');
  await dialog.getByRole('button', { name: 'Review payment', exact: true }).click();
  await expect(dialog).toContainText('No payment has been recorded yet');
  await dialog.getByRole('button', { name: 'Confirm payment', exact: true }).click();
  await expect(dialog).toContainText('Fee payment receipt');
  await expect(dialog).toContainText('STU001');
  await expect(dialog).toContainText('Verified browser payment');
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.fee-receipt')).toBeVisible();
  await expect(page.locator('#root')).not.toBeVisible();
  await page.emulateMedia({ media: 'screen' });
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(row).toContainText('₹60.00');
  const paid = (
    await platformApp.db.query<{ receipt_no: string }>(
      "SELECT receipt_no FROM fee_payments WHERE note='Verified browser payment' ORDER BY created_at DESC LIMIT 1",
    )
  ).rows[0];
  const history = page.getByRole('article').filter({ hasText: paid.receipt_no });
  await history.getByRole('button', { name: 'Reverse', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('textbox', { name: 'Reason', exact: true })
    .fill('Incorrect reference; replace with verified receipt');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Confirm correction', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(history).toContainText('Reversed:');
  await expect(row).toContainText('₹100.00');
  await page.getByRole('button', { name: 'Dashboard & reports', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export Excel / CSV', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('vidyalayaa-fees.csv');
  const audit = await new AxeBuilder({ page }).include('main').analyze();
  expect(audit.violations.filter((v) => ['serious', 'critical'].includes(v.impact || ''))).toEqual(
    [],
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `tmp/qa/fees-${testInfo.project.name}.png`, fullPage: true });
});
test('School Admin adds routes and bills transport only for the selected student', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  const f = platformApp.records;
  await page.goto(authAppURL + '/admin/r/fee_records');
  await page.getByRole('button', { name: 'Transport routes', exact: true }).click();
  await page.getByRole('button', { name: 'Add route', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('textbox', { name: 'Route / service name', exact: true })
    .fill('Browser bus route');
  await page.getByRole('dialog').getByRole('button', { name: 'Save route', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Student fees', exact: true }).click();
  await page.getByRole('combobox', { name: 'Class', exact: true }).selectOption('8');
  await page.getByRole('combobox', { name: 'Section', exact: true }).selectOption(f.classId);
  await page.getByRole('combobox', { name: 'Student', exact: true }).selectOption(f.student);
  await page.getByRole('button', { name: 'Assign transport', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const route = (
    await platformApp.db.query<{ id: string }>(
      "SELECT id FROM fee_transport_routes WHERE name='Browser bus route'",
    )
  ).rows[0];
  await dialog
    .getByRole('combobox', { name: 'Route / service', exact: true })
    .selectOption(route.id);
  await dialog
    .getByRole('spinbutton', { name: 'Bus fee per installment (INR)', exact: true })
    .fill('25');
  await dialog
    .getByRole('combobox', { name: 'Billing frequency', exact: true })
    .selectOption('ONE_TIME');
  page.on('dialog', (d) => d.accept());
  await dialog.getByRole('button', { name: 'Assign and assess transport', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole('row').filter({ hasText: 'Transport · Browser bus route' }),
  ).toContainText('₹25.00');
});

test('School Admin configures different section fees and edits a route without repricing history', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  const f = platformApp.records,
    newSection = crypto.randomUUID();
  await platformApp.db.query(
    "INSERT INTO classes(id,school_id,academic_session_id,grade,section) VALUES($1,$2,$3,'8','B')",
    [newSection, f.schoolA, f.session],
  );
  await page.goto(authAppURL + '/admin/r/fee_records');
  await page.getByRole('combobox', { name: 'Class', exact: true }).selectOption('8');
  await page.getByRole('button', { name: 'Class fee structures', exact: true }).click();
  await page.getByRole('button', { name: 'Edit as new version', exact: true }).click();
  const dialog = page.getByRole('dialog');
  page.on('dialog', (d) => d.accept());
  await dialog
    .getByRole('combobox', { name: 'Section fee configuration', exact: true })
    .selectOption('SECTION');
  for (const [section, amount] of [
    ['A', '120'],
    ['B', '150'],
  ]) {
    // Native sections without an accessible name are scoped by their heading.
    const panel = dialog
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Section ' + section, exact: true }) });
    await panel.getByRole('button', { name: 'Add fee category', exact: true }).click();
    await panel
      .getByRole('textbox', { name: 'Fee label', exact: true })
      .fill('Section tuition ' + section);
    await panel
      .getByRole('spinbutton', { name: 'Amount per installment (INR)', exact: true })
      .fill(amount);
    await panel.getByRole('combobox', { name: 'Schedule', exact: true }).selectOption('ONE_TIME');
  }
  await dialog.getByRole('button', { name: 'Save new version', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(/Different fees by section/)).toBeVisible();
  const latest = await platformApp.request(
    '/fees/structures?academic_session_id=' + f.session + '&grade=8',
    'GET',
    undefined,
    f.admin,
    f.schoolA,
  );
  expect(
    latest.body.data[0].items
      .map((i: { amount: string }) => Number(i.amount))
      .sort((a: number, b: number) => a - b),
  ).toEqual([120, 150]);
  expect(
    (
      await platformApp.db.query<{ amount_due: string }>(
        "SELECT amount_due FROM fee_records WHERE fee_type='Browser tuition' AND student_id=$1",
        [f.student],
      )
    ).rows[0].amount_due,
  ).toBe('100.00');
  await page.getByRole('button', { name: 'Transport routes', exact: true }).click();
  const route = page.getByRole('article').filter({ hasText: 'Browser bus route' });
  await route.getByRole('button', { name: 'Edit route', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('checkbox', { name: 'Available for new assignments', exact: true })
    .uncheck();
  await page.getByRole('dialog').getByRole('button', { name: 'Save route', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(route).toContainText('Unavailable for new assignments');
  expect(
    (
      await platformApp.db.query<{ amount: string }>(
        'SELECT amount FROM fee_transport_assignments WHERE student_id=$1',
        [f.student],
      )
    ).rows[0].amount,
  ).toBe('25.00');
});
