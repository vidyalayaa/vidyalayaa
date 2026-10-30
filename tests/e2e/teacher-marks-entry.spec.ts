import { expect } from '@playwright/test';
import { test } from './fixtures/teacher-app';
test.setTimeout(120000);
test('teacher enters assigned subject-test marks by roll number and downloads the filled class template', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  const f = platformApp.records,
    admin = (path: string, method = 'GET', body?: unknown) =>
      platformApp.request(path, method, body, f.admin, f.schoolA);
  const exam = await admin('/resources/exams', 'POST', {
    name: 'Teacher roll entry test',
    class_id: f.classId,
    assessment_kind: 'SUBJECT_TEST',
    subject_id: f.subject,
    exam_type: 'UNIT',
    max_score: 50,
    status: 'OPEN',
  });
  expect(exam.status).toBe(201);
  await page.goto(authAppURL + '/teacher/subject-tests');
  await page.getByLabel('Assigned class and section', { exact: true }).selectOption(f.classId);
  const row = page.getByRole('row').filter({ hasText: 'Teacher roll entry test' });
  await row.getByRole('button', { name: 'Enter by roll number', exact: true }).click();
  const roster = (
    await platformApp.request(
      '/marks/entry-sheet?exam_id=' + exam.body.id,
      'GET',
      undefined,
      f.teacher,
      f.schoolA,
    )
  ).body.students;
  for (let i = 0; i < roster.length; i++) {
    await page.getByRole('spinbutton', { name: 'Score (maximum 50)', exact: true }).fill('45');
    await page.getByRole('spinbutton', { name: 'Score (maximum 50)', exact: true }).press('Enter');
    if (i + 1 < roster.length)
      await expect(
        page.getByRole('combobox', { name: 'Student by roll number', exact: true }),
      ).toHaveValue(String(i + 1));
  }
  await expect(page.getByRole('heading', { name: 'End of this class roster' })).toBeVisible();
  await expect(page.getByText('All entered marks saved.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await row.getByRole('button', { name: 'Upload marks CSV', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Template subject', exact: true })).toContainText(
    'Mathematics',
  );
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download filled CSV template', exact: true }).click();
  expect((await download).suggestedFilename()).toContain(exam.body.id);
  const marks = (await admin('/resources/marks?exam_id=' + exam.body.id)).body.data;
  expect(Number(marks[0].score)).toBe(45);
});
