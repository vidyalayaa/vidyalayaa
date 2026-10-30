import { expect, type Page } from '@playwright/test';
import { test } from './fixtures/school-admin-app';
import type { PlatformApp } from './fixtures/platform-app';
import AxeBuilder from '@axe-core/playwright';
test.setTimeout(120000);
async function setup(p: PlatformApp, suffix: string) {
  const f = p.records,
    call = (path: string, method = 'GET', body?: unknown) =>
      p.request(path, method, body, f.admin, f.schoolA);
  const c = await call('/resources/classes', 'POST', {
    academic_session_id: f.session,
    grade: '6',
    section: 'FAST_' + suffix,
    class_teacher_id: f.teacherId,
  });
  expect(c.status).toBe(201);
  const subject = await call(`/academics/classes/${c.body.id}/subjects`, 'POST', {
    subject: { code: 'FAST_' + suffix, name: 'Instant mathematics' },
    teacher_id: f.teacherId,
    starts_on: '2026-01-01',
  });
  expect(subject.status).toBe(201);
  const students: string[] = [];
  for (let i = 1; i <= 3; i++) {
    const s = await call('/resources/students', 'POST', {
      student_code: `FAST_${suffix}_${i}`,
      first_name: 'Fast learner ' + i,
    });
    expect(s.status).toBe(201);
    students.push(s.body.id);
    expect(
      (
        await call('/resources/enrollments', 'POST', {
          class_id: c.body.id,
          student_id: s.body.id,
          academic_session_id: f.session,
          roll_number: String(i),
          starts_on: '2026-01-01',
        })
      ).status,
    ).toBe(201);
  }
  const exam = await call('/resources/exams', 'POST', {
    name: 'Fast entry ' + suffix,
    class_id: c.body.id,
    assessment_kind: 'SUBJECT_TEST',
    subject_id: subject.body.subject.id,
    exam_type: 'UNIT',
    max_score: 100,
    status: 'OPEN',
  });
  expect(exam.status).toBe(201);
  return {
    call,
    classId: c.body.id,
    examId: exam.body.id,
    subjectId: subject.body.subject.id,
    students,
  };
}
async function open(page: Page, url: string, s: Awaited<ReturnType<typeof setup>>) {
  await page.goto(url + '/admin/r/marks');
  await page.getByLabel('Class and section', { exact: true }).selectOption(s.classId);
  await page.getByLabel('Examination', { exact: true }).selectOption(s.examId);
  await page.getByRole('button', { name: 'Enter by roll number', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Roll number: 1');
}
test('Enter advances and focuses instantly before any server reply, preserving later input while queued saves finish', async ({
  page,
  authAppURL,
  platformApp,
}, info) => {
  const s = await setup(platformApp, 'LATENCY');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sent: { student_id: string; subject_id: string; score: number }[] = [];
  await page.route('**/api/v1/marks/entry', async (route) => {
    sent.push(route.request().postDataJSON().entries[0]);
    if (sent.length === 1) await gate;
    const response = await route.fetch({ url: platformApp.url + '/api/v1/marks/entry' });
    await route.fulfill({ response });
  });
  try {
    await open(page, authAppURL, s);
    const dialog = page.getByRole('dialog'),
      score = dialog.getByRole('spinbutton', { name: 'Score (maximum 100)', exact: true });
    await score.fill('31');
    await score.press('Enter');
    await expect(dialog).toContainText('Roll number: 2');
    await expect(score).toBeFocused();
    await expect(score).toHaveValue('');
    await score.fill('45');
    await score.press('Enter');
    await expect(dialog).toContainText('Roll number: 3');
    await expect(score).toBeFocused();
    await score.fill('0');
    await expect(dialog.getByRole('status')).toContainText('0 saved · 2 pending');
    expect(sent).toHaveLength(1);
    expect((await s.call('/resources/marks?exam_id=' + s.examId)).body.total).toBe(0);
    const audit = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
    expect(
      audit.violations.filter((v) => ['serious', 'critical'].includes(v.impact || '')),
    ).toEqual([]);
    await page.screenshot({
      path: `tmp/qa/instant-marks-${info.project.name}.png`,
      fullPage: true,
    });
    release();
    await expect(dialog.getByRole('status')).toContainText(
      '2 saved · current score not submitted.',
    );
    await expect(score).toHaveValue('0');
    await score.press('Enter');
    await expect(dialog.getByRole('heading', { name: 'End of this class roster' })).toBeVisible();
    await expect(dialog.getByText('All entered marks saved.', { exact: true })).toBeVisible();
    expect(sent.map((m) => m.student_id)).toEqual(s.students);
    expect(sent.map((m) => m.score)).toEqual([31, 45, 0]);
    expect(sent.every((m) => m.subject_id === s.subjectId)).toBe(true);
    const rows = (await s.call('/resources/marks?exam_id=' + s.examId)).body.data;
    for (let i = 0; i < 3; i++)
      expect(Number(rows.find((m: any) => m.student_id === s.students[i]).score)).toBe(
        [31, 45, 0][i],
      );
  } finally {
    release();
  }
});
test('lost acknowledgements retain queued scores on close and resume with the same retry key', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  const s = await setup(platformApp, 'RESUME');
  let drop = true;
  const keys: string[] = [];
  await page.route('**/api/v1/marks/entry', async (route) => {
    keys.push(route.request().headers()['idempotency-key']);
    const response = await route.fetch({ url: platformApp.url + '/api/v1/marks/entry' });
    if (drop) {
      drop = false;
      expect(response.status()).toBe(200);
      await route.abort('failed');
    } else await route.fulfill({ response });
  });
  await open(page, authAppURL, s);
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('spinbutton', { name: 'Score (maximum 100)', exact: true }).fill('38');
  await dialog.getByRole('spinbutton', { name: 'Score (maximum 100)', exact: true }).press('Enter');
  await expect(dialog).toContainText('Roll number: 2');
  await expect(dialog.getByRole('alert')).toContainText('Some saves are not confirmed');
  page.once('dialog', (d) => d.accept());
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Enter by roll number', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Some saves are not confirmed');
  await expect(
    dialog.getByRole('spinbutton', { name: 'Score (maximum 100)', exact: true }),
  ).toHaveValue('38');
  expect(keys).toHaveLength(1);
  await dialog.getByRole('button', { name: 'Retry pending saves', exact: true }).click();
  await expect(dialog.getByText('All entered marks saved.', { exact: true })).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  expect((await s.call('/resources/marks?exam_id=' + s.examId)).body.total).toBe(1);
});
