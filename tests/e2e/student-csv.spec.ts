import { expect, type Download } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { test } from './fixtures/school-admin-app';
import { studentImportColumns } from '@vidyalayaa/contracts';
import { parseCsv } from '../../apps/web/src/lib/csv';

test.setTimeout(120000);
async function contents(download: Download) {
  const stream = await download.createReadStream();
  if (!stream) throw new Error('The CSV download did not complete.');
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
const encode = (rows: Record<string, unknown>[]) =>
  '\uFEFF' +
  studentImportColumns.join(',') +
  '\r\n' +
  rows
    .map((r) =>
      studentImportColumns
        .map((k) => '"' + String(r[k] ?? '').replaceAll('"', '""') + '"')
        .join(','),
    )
    .join('\r\n');
const row = (code: string) => ({
  student_code: code,
  first_name: 'CSV website',
  last_name: 'Learner',
  email: code.toLowerCase() + '@example.test',
  date_of_birth: '2013-04-05',
  gender: 'FEMALE',
  academic_session: 'Test year',
  class_grade: '8',
  class_section: 'A',
  roll_number: '67',
  starts_on: '2026-01-01',
  parent_1_full_name: 'CSV website parent',
  parent_1_email: code.toLowerCase() + '-parent@example.test',
  parent_1_phone: '9876543210',
  parent_1_relationship: 'MOTHER',
  parent_1_can_receive_alerts: false,
});

test('School Admin downloads the full template, validates and imports families, then exports complete filtered records', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  await page.goto(authAppURL + '/admin/r/students');
  await page.getByRole('button', { name: 'Import CSV', exact: true }).click();
  const templateDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download CSV template', exact: true }).click();
  const template = await contents(await templateDownload);
  expect(parseCsv(template)[0]).toEqual(studentImportColumns);
  expect(template).toContain('gender');
  expect(template).toContain('parent_2_can_receive_alerts');
  expect(template).not.toContain('parent_3_');
  await page.getByLabel('CSV file', { exact: true }).setInputFiles({
    name: 'full-students.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(encode([row('CSV_BROWSER')])),
  });
  await expect(
    page.getByRole('button', { name: 'Import validated records', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Validate file', exact: true }).click();
  await expect(page.getByText('All rows validated. Ready to import.')).toBeVisible();
  const f = platformApp.records;
  expect(
    (
      await platformApp.request(
        '/resources/students?search=CSV_BROWSER',
        'GET',
        undefined,
        f.admin,
        f.schoolA,
      )
    ).body.total,
  ).toBe(0);
  const axe = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
  expect(axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact || ''))).toEqual(
    [],
  );
  await page.getByRole('button', { name: 'Import validated records', exact: true }).click();
  await expect(page.getByRole('status')).toContainText(
    '1 student imported with class enrollments and family connections.',
  );
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('main').getByLabel('Search students', { exact: true }).fill('CSV_BROWSER');
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV', exact: true }).click();
  const exported = await contents(await downloaded),
    [header, ...records] = parseCsv(exported);
  expect(records).toHaveLength(1);
  const result = Object.fromEntries(header.map((k, i) => [k, records[0][i]]));
  expect(result).toMatchObject({
    student_code: 'CSV_BROWSER',
    gender: 'FEMALE',
    class_grade: '8',
    class_section: 'A',
    roll_number: '67',
    parent_1_full_name: 'CSV website parent',
    parent_1_relationship: 'MOTHER',
    parent_1_can_receive_alerts: 'false',
  });
  expect(exported).not.toContain('Foreign learner');
});

test('invalid CSV rows save nothing and changing a validated file requires validation again', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  await page.goto(authAppURL + '/admin/r/students');
  await page.getByRole('button', { name: 'Import CSV', exact: true }).click();
  const preview = page.getByRole('textbox', { name: 'CSV preview', exact: true });
  await preview.fill(
    encode([
      row('CSV_BROWSER_ROLLBACK'),
      { ...row('CSV_BROWSER_INVALID'), class_section: 'MISSING' },
    ]),
  );
  await page.getByRole('button', { name: 'Validate file', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('CSV row 3');
  const f = platformApp.records;
  expect(
    (
      await platformApp.request(
        '/resources/students?search=CSV_BROWSER_ROLLBACK',
        'GET',
        undefined,
        f.admin,
        f.schoolA,
      )
    ).body.total,
  ).toBe(0);
  await preview.fill(encode([row('CSV_BROWSER_CHANGED')]));
  await page.getByRole('button', { name: 'Validate file', exact: true }).click();
  await expect(page.getByText('All rows validated. Ready to import.')).toBeVisible();
  await preview.fill(
    encode([{ ...row('CSV_BROWSER_CHANGED'), first_name: 'Changed after validation' }]),
  );
  await expect(
    page.getByRole('button', { name: 'Import validated records', exact: true }),
  ).toBeDisabled();
  await expect(page.getByText('All rows validated. Ready to import.')).toHaveCount(0);
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
});

test('CSV import retries a lost commit response without duplicating the student or family', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  let dropResponse = true;
  const keys: string[] = [];
  await page.route('**/api/v1/student-directory/imports', async (route) => {
    if (route.request().postDataJSON().validate_only) return route.fallback();
    keys.push(route.request().headers()['idempotency-key']);
    const response = await route.fetch({
      url: platformApp.url + '/api/v1/student-directory/imports',
    });
    if (dropResponse) {
      expect(response.status()).toBe(201);
      dropResponse = false;
      await route.abort('failed');
    } else await route.fulfill({ response });
  });
  await page.goto(authAppURL + '/admin/r/students');
  await page.getByRole('button', { name: 'Import CSV', exact: true }).click();
  await page.getByLabel('CSV preview', { exact: true }).fill(encode([row('CSV_RETRY_BROWSER')]));
  await page.getByRole('button', { name: 'Validate file', exact: true }).click();
  const save = page.getByRole('button', { name: 'Import validated records', exact: true });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(
    page.getByText('1 student imported with class enrollments and family connections.'),
  ).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  const f = platformApp.records;
  const students = await platformApp.request(
    '/resources/students?search=CSV_RETRY_BROWSER',
    'GET',
    undefined,
    f.admin,
    f.schoolA,
  );
  expect(students.body.total).toBe(1);
  const links = await platformApp.request(
    `/resources/student_parents?student_id=${students.body.data[0].id}`,
    'GET',
    undefined,
    f.admin,
    f.schoolA,
  );
  expect(links.body.total).toBe(1);
});
