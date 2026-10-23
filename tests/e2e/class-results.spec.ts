import { expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { test } from './fixtures/school-admin-app';
import type { PlatformApp } from './fixtures/platform-app';

test.setTimeout(120000);
async function setup(p: PlatformApp, suffix: string) {
  const f = p.records;
  const call = (path: string, method = 'GET', body?: unknown) =>
    p.request(path, method, body, f.admin, f.schoolA);
  const section = await call('/resources/classes', 'POST', {
    academic_session_id: f.session,
    grade: '8',
    section: 'RESULT_' + suffix,
    class_teacher_id: f.teacherId,
  });
  expect(section.status).toBe(201);
  const english = await call('/resources/subjects', 'POST', {
    code: 'ENG_' + suffix,
    name: 'English ' + suffix,
  });
  expect(english.status).toBe(201);
  expect(
    (
      await call('/resources/teacher_class_assignments', 'POST', {
        class_id: section.body.id,
        subject_id: english.body.id,
        teacher_id: f.teacherId,
        starts_on: '2026-01-01',
      })
    ).status,
  ).toBe(201);
  const child = await call('/resources/students', 'POST', {
    student_code: 'CHILD_' + suffix,
    first_name: 'Other section ' + suffix,
  });
  expect(child.status).toBe(201);
  expect(
    (
      await call('/resources/enrollments', 'POST', {
        student_id: child.body.id,
        class_id: section.body.id,
        academic_session_id: f.session,
        starts_on: '2026-01-01',
      })
    ).status,
  ).toBe(201);
  const createExam = async (
    classId: string,
    subjectId: string | null,
    name: string,
    status = 'OPEN',
  ) => {
    const r = await call('/resources/exams', 'POST', {
      class_id: classId,
      subject_id: subjectId,
      assessment_kind: subjectId ? 'SUBJECT_TEST' : 'OFFICIAL',
      name,
      exam_type: 'UNIT',
      max_score: 100,
      status,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as string;
  };
  return {
    f,
    call,
    section: section.body.id as string,
    english: english.body.id as string,
    child: child.body.id as string,
    createExam,
  };
}

test('Class-first results isolate examinations and student choices, save/edit subject-test marks and reset on class changes', async ({
  page,
  authAppURL,
  platformApp,
}, testInfo) => {
  const s = await setup(platformApp, 'SCOPED'),
    examA = await s.createExam(s.f.classId, s.f.subject, 'A mathematics subject test'),
    examB = await s.createExam(s.section, s.english, 'B English subject test');
  await page.goto(authAppURL + '/admin/r/marks');
  await expect(page.getByRole('heading', { name: 'Results', exact: true })).toBeVisible({
    timeout: 30000,
  });
  await expect(page.getByRole('combobox', { name: 'Examination', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Add record', exact: true })).toHaveCount(0);
  await page
    .getByRole('combobox', { name: 'Class and section', exact: true })
    .selectOption(s.f.classId);
  await expect(page.locator('#results-exam option')).not.toContainText(['B English subject test']);
  await page.getByRole('combobox', { name: 'Examination', exact: true }).selectOption(examA);
  await page.getByRole('button', { name: 'Add record', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Subject: Mathematics');
  await expect(dialog.locator('#exam_id')).toHaveCount(0);
  await expect(dialog.locator('#subject_id')).toHaveCount(0);
  await expect(dialog.locator('#student_id option')).not.toContainText(['Other section SCOPED']);
  await dialog.locator('#student_id').selectOption(s.f.student);
  await dialog.locator('#score').fill('81');
  await dialog.locator('#remarks').fill('Class A result only');
  const formAudit = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
  expect(
    formAudit.violations.filter((v) => ['serious', 'critical'].includes(v.impact || '')),
  ).toEqual([]);
  await dialog.getByRole('button', { name: 'Save record', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const row = page.getByRole('row').filter({ hasText: 'Test learner · STU001' });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: /^Edit / }).click();
  await page.getByRole('dialog').locator('#score').fill('82');
  await page.getByRole('dialog').getByRole('button', { name: 'Save record', exact: true }).click();
  await expect(row).toContainText('82');
  await page
    .getByRole('combobox', { name: 'Class and section', exact: true })
    .selectOption(s.section);
  await expect(page.getByRole('combobox', { name: 'Examination', exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Add record', exact: true })).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Examination', exact: true }).selectOption(examB);
  await page.getByRole('button', { name: 'Add record', exact: true }).click();
  await expect(page.getByRole('dialog').locator('#student_id option')).not.toContainText([
    'Test learner',
  ]);
  await page.getByRole('dialog').locator('#student_id').selectOption(s.child);
  await page.getByRole('dialog').locator('#score').fill('92');
  await page.getByRole('dialog').locator('#remarks').fill('Class B result only');
  await page.getByRole('dialog').getByRole('button', { name: 'Save record', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Other section SCOPED' })).toContainText(
    '92',
  );
  await expect(page.getByRole('row').filter({ hasText: 'Test learner · STU001' })).toHaveCount(0);
  expect((await s.call('/resources/marks?exam_id=' + examA)).body.data[0].remarks).toBe(
    'Class A result only',
  );
  expect(
    (await s.call(`/resources/marks?class_id=${s.f.classId}&exam_id=${examB}`)).body.total,
  ).toBe(0);
  const audit = await new AxeBuilder({ page }).include('main').analyze();
  expect(audit.violations.filter((v) => ['serious', 'critical'].includes(v.impact || ''))).toEqual(
    [],
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `tmp/qa/class-results-${testInfo.project.name}.png`,
    fullPage: true,
  });
});

test('Official results show only configured class subjects and locked exams stay read-only', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  const s = await setup(platformApp, 'OFFICIAL'),
    exam = await s.createExam(s.f.classId, null, 'Official class A results');
  await page.goto(authAppURL + '/admin/r/marks');
  await page
    .getByRole('combobox', { name: 'Class and section', exact: true })
    .selectOption(s.f.classId);
  await page.getByRole('combobox', { name: 'Examination', exact: true }).selectOption(exam);
  await page.getByRole('button', { name: 'Add record', exact: true }).click();
  await expect(page.getByRole('dialog').locator('#subject_id option')).not.toContainText([
    'English OFFICIAL',
  ]);
  await page.getByRole('dialog').locator('#student_id').selectOption(s.f.student);
  await page.getByRole('dialog').locator('#subject_id').selectOption(s.f.subject);
  await page.getByRole('dialog').locator('#score').fill('74');
  await page.getByRole('dialog').getByRole('button', { name: 'Save record', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await s.call('/resources/exams/' + exam, 'PATCH', { status: 'LOCKED' })).status).toBe(
    200,
  );
  await page.reload();
  await page
    .getByRole('combobox', { name: 'Class and section', exact: true })
    .selectOption(s.f.classId);
  await page.getByRole('combobox', { name: 'Examination', exact: true }).selectOption(exam);
  await expect(page.getByRole('main')).toContainText('This examination is read-only');
  await expect(page.getByRole('button', { name: 'Add record', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Import CSV', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Edit / })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'View', exact: true })).toHaveCount(1);
});

test('Creating a class subject test filters subjects and clears the subject when the class changes', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  const s = await setup(platformApp, 'CREATE');
  await page.goto(authAppURL + '/admin/r/exams');
  await page.getByRole('button', { name: 'Add record', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('#class_id').selectOption(s.f.classId);
  await dialog.locator('#assessment_kind').selectOption('SUBJECT_TEST');
  await dialog.locator('#subject_id').selectOption(s.f.subject);
  await expect(dialog.locator('#subject_id option')).not.toContainText(['English CREATE']);
  await dialog.locator('#class_id').selectOption(s.section);
  await expect(dialog.locator('#subject_id')).toHaveValue('');
  await dialog.locator('#subject_id').selectOption(s.english);
  await expect(dialog.locator('#subject_id option')).not.toContainText(['Mathematics']);
  await dialog.locator('#name').fill('Created B English class test');
  await dialog.locator('#max_score').fill('50');
  await dialog.locator('#status').selectOption('OPEN');
  await dialog.getByRole('button', { name: 'Save record', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const result = await s.call('/resources/exams?class_id=' + s.section);
  expect(
    result.body.data.some(
      (r: { name: string; subject_id: string }) =>
        r.name === 'Created B English class test' && r.subject_id === s.english,
    ),
  ).toBe(true);
});
