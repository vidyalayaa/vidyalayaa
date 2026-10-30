import { expect } from '@playwright/test';
import { test } from './fixtures/school-admin-app';
test.use({ implicitSchool: true });
test.setTimeout(120000);
test('single-school default saves and retries retained marks without an explicit school selector', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  const f = platformApp.records;
  const created = await platformApp.request(
    '/resources/exams',
    'POST',
    {
      name: 'Implicit school pending marks',
      class_id: f.classId,
      assessment_kind: 'SUBJECT_TEST',
      subject_id: f.subject,
      exam_type: 'UNIT',
      max_score: 100,
      status: 'OPEN',
    },
    f.admin,
    f.schoolA,
  );
  expect(created.status).toBe(201);
  const keys: string[] = [];
  let reject = true;
  await page.route('**/api/v1/marks/entry', async (route) => {
    expect(route.request().headers()['x-school-id']).toBeUndefined();
    keys.push(route.request().headers()['idempotency-key']);
    if (reject) {
      reject = false;
      return route.fulfill({
        status: 409,
        json: {
          error: {
            code: 'CONTEXT_CHANGED',
            message:
              'Your account or school changed. Return to the original account and school before retrying these marks.',
          },
        },
      });
    }
    const response = await route.fetch({ url: platformApp.url + '/api/v1/marks/entry' });
    expect(response.status()).toBe(200);
    await route.fulfill({ response });
  });
  await page.goto(authAppURL + '/admin/r/marks');
  expect(await page.evaluate(() => sessionStorage.getItem('vidyalayaa.school'))).toBe('');
  await page.getByLabel('Class and section', { exact: true }).selectOption(f.classId);
  await page.getByLabel('Examination', { exact: true }).selectOption(created.body.id);
  await page.getByRole('button', { name: 'Enter by roll number', exact: true }).click();
  const dialog = page.getByRole('dialog'),
    score = dialog.getByRole('spinbutton', { name: 'Score (maximum 100)', exact: true });
  await score.fill('88');
  await score.press('Enter');
  await expect(dialog.getByRole('alert')).toContainText('Some saves are not confirmed');
  await dialog.getByRole('button', { name: 'Retry pending saves', exact: true }).click();
  await expect(dialog.getByText('All entered marks saved.', { exact: true })).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  const rows = (
    await platformApp.request(
      '/resources/marks?exam_id=' + created.body.id,
      'GET',
      undefined,
      f.admin,
      f.schoolA,
    )
  ).body.data;
  expect(rows).toHaveLength(1);
  expect(rows[0].student_id).toBe(f.student);
  expect(Number(rows[0].score)).toBe(88);
});
