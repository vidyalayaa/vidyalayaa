import { expect, type Page } from '@playwright/test';
import { test } from './fixtures/teacher-app';
import { randomUUID } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';

async function fill(page: Page, values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    const control = page.getByRole('dialog').last().locator(`[id="${key}"]`);
    if ((await control.evaluate((e) => e.tagName)) === 'SELECT') await control.selectOption(value);
    else await control.fill(value);
  }
}
async function save(page: Page) {
  await page
    .getByRole('dialog')
    .last()
    .getByRole('button', { name: 'Save record', exact: true })
    .click();
}

test('Teacher chooses an assigned class and sees its students and authorized parents', async ({
  page,
  authAppURL,
  platformApp,
  isMobile,
}) => {
  const f = platformApp.records,
    admin = (path: string, body: unknown) =>
      platformApp.request(path, 'POST', body, f.admin, f.schoolA);
  const staff = (
    await platformApp.request('/resources/teachers', 'GET', undefined, f.admin, f.schoolA)
  ).body.data.find((t: any) => t.user_id === f.teacher);
  const subject = await admin('/resources/subjects', {
    code: 'ROSTER_ENGLISH',
    name: 'English roster subject',
  });
  expect(subject.status).toBe(201);
  const second = await admin('/resources/classes', {
    academic_session_id: f.session,
    grade: '9',
    section: 'ROSTER',
    class_teacher_id: staff.id,
  });
  expect(second.status).toBe(201);
  const student = await admin('/resources/students', {
    student_code: 'ROSTER_B',
    first_name: 'Second classroom learner',
  });
  expect(student.status).toBe(201);
  const parent = await admin('/resources/parents', {
    full_name: 'Second classroom guardian',
    email: 'second-guardian@example.invalid',
  });
  expect(parent.status).toBe(201);
  expect(
    (
      await admin('/resources/enrollments', {
        student_id: student.body.id,
        class_id: second.body.id,
        academic_session_id: f.session,
        starts_on: '2026-01-01',
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await admin('/resources/student_parents', {
        student_id: student.body.id,
        parent_id: parent.body.id,
        relationship: 'GUARDIAN',
      })
    ).status,
  ).toBe(201);
  for (const cid of [f.classId, second.body.id])
    expect(
      (
        await admin('/resources/teacher_class_assignments', {
          teacher_id: staff.id,
          class_id: cid,
          subject_id: subject.body.id,
          starts_on: '2026-01-01',
        })
      ).status,
    ).toBe(201);
  await page.goto(authAppURL + '/teacher/classroom');
  await page
    .getByLabel('Assigned class and section', { exact: true })
    .selectOption(platformApp.records.classId);
  await expect(page.getByRole('main')).toContainText('Test learner');
  await expect(page.getByRole('main')).toContainText('Parent Test');
  await expect(page.getByRole('main')).toContainText('parent@example.invalid');
  await page.getByLabel('Assigned class and section', { exact: true }).selectOption(second.body.id);
  await expect(page.getByRole('main')).toContainText('Second classroom learner');
  await expect(page.getByRole('main')).toContainText('Second classroom guardian');
  await expect(page.getByRole('main')).not.toContainText('Parent Test');
  await expect(page.getByRole('main')).not.toContainText('STU001');
  if (isMobile) await page.getByRole('button', { name: 'Open navigation' }).click();
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(nav.getByRole('link', { name: 'Students & Parents', exact: true })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Academics', exact: true })).toHaveCount(0);
  for (const path of [
    '/teacher/r/classes',
    '/teacher/r/academic_sessions',
    '/teacher/r/teacher_class_assignments',
    '/admin',
  ]) {
    await page.goto(authAppURL + path);
    await expect(
      page.getByRole('heading', { name: 'Access unavailable', exact: true }),
    ).toBeVisible();
  }
});

test('Teacher marks only their assigned class register', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  await page.goto(authAppURL + '/teacher/attendance');
  await page.getByRole('button', { name: 'Class Register', exact: true }).click();
  await page.getByLabel('Select Class & Section').selectOption(platformApp.records.classId);
  await page.getByLabel('Attendance Date', { exact: true }).fill('2026-10-21');
  await expect(page.getByRole('dialog')).toContainText('Test learner');
  await page.getByRole('button', { name: 'All Present', exact: true }).click();
  await page.getByRole('button', { name: 'Save Class Attendance', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByLabel('Attendance date', { exact: true }).fill('2026-10-21');
  await expect(page.getByRole('row').filter({ hasText: 'STU001' })).toContainText(/PRESENT/i);
});

test('Subject teacher views attendance but cannot mark or correct their assigned class', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  const f = platformApp.records;
  const admin = (path: string, method = 'GET', body?: unknown) =>
    platformApp.request(path, method, body, f.admin, f.schoolA);
  const replacement = await admin('/resources/teachers', 'POST', {
    staff_code: 'ATTENDANCE_CT',
    full_name: 'Attendance Class Teacher',
    staff_role: 'teacher',
  });
  expect(replacement.status).toBe(201);
  expect(
    (
      await admin('/resources/classes/' + f.classId, 'PATCH', {
        class_teacher_id: replacement.body.id,
      })
    ).status,
  ).toBe(200);
  await page.goto(authAppURL + '/teacher/attendance');
  await page.getByLabel('Class', { exact: true }).selectOption(f.classId);
  await expect(page.getByRole('main')).toContainText('STU001');
  await expect(page.getByRole('button', { name: 'Class Register', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Mark attendance', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Request correction', exact: true })).toHaveCount(
    0,
  );
  const denied = await platformApp.request(
    '/attendance/manual',
    'POST',
    {
      student_id: f.student,
      date: '2026-10-21',
      status: 'ABSENT',
      reason: 'Subject teacher cannot change attendance',
    },
    f.teacher,
    f.schoolA,
  );
  expect(denied.status).toBe(403);
  expect(
    (await admin('/resources/classes/' + f.classId, 'PATCH', { class_teacher_id: f.teacherId }))
      .status,
  ).toBe(200);
});

test('Teacher creates homework with only an assigned class and subject', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  await page.goto(authAppURL + '/teacher/r/assignments');
  await page.getByRole('button', { name: 'Add record', exact: true }).click();
  await fill(page, {
    class_id: platformApp.records.classId,
    subject_id: platformApp.records.subject,
    title: 'Assigned classroom homework ' + randomUUID().slice(0, 6),
    body: 'Explain each step.',
  });
  await expect(page.locator('#subject_id')).toContainText('Mathematics');
  await save(page);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('main')).toContainText('Assigned classroom homework');
});

test('Teacher creates a subject test, enters and edits marks, and uploads CSV', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  const f = platformApp.records,
    title = 'Teacher browser test ' + randomUUID().slice(0, 6);
  await page.goto(authAppURL + '/teacher/subject-tests');
  await page.getByLabel('Assigned class and section', { exact: true }).selectOption(f.classId);
  await page.getByLabel('Assigned subject', { exact: true }).selectOption(f.subject);
  await page.getByRole('button', { name: 'Create subject test', exact: true }).click();
  await fill(page, { name: title, exam_type: 'UNIT', max_score: '20', status: 'OPEN' });
  await save(page);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const row = page.getByRole('row').filter({ hasText: title });
  await row.getByRole('button', { name: 'Enter marks', exact: true }).click();
  await page.getByRole('button', { name: 'Add marks', exact: true }).click();
  await fill(page, {
    student_id: f.student,
    score: '17',
    remarks: 'Browser verified subject marks',
  });
  await save(page);
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(page.getByRole('dialog')).toContainText('17');
  await page.getByRole('button', { name: 'Edit marks', exact: true }).click();
  await fill(page, { score: '18' });
  await save(page);
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(page.getByRole('dialog')).toContainText('18');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await row.getByRole('button', { name: 'Upload marks CSV', exact: true }).click();
  await page.getByLabel('Marks CSV').setInputFiles({
    name: 'subject-marks.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('student_code,subject_code,score,remarks\nSTU001,MAT,19,CSV subject marks'),
  });
  await page.getByRole('button', { name: 'Import marks', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await row.getByRole('button', { name: 'Enter marks', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('CSV subject marks');
});

test('Teacher teaching pages are responsive and have no serious accessibility violations', async ({
  page,
  authAppURL,
  platformApp,
}, info) => {
  test.setTimeout(60000);
  for (const path of [
    '/teacher',
    '/teacher/classroom',
    '/teacher/subject-tests',
    '/teacher/official-results',
  ]) {
    await page.goto(authAppURL + path);
    await page.getByRole('heading', { level: 1 }).waitFor();
    if (path === '/teacher/classroom' || path === '/teacher/subject-tests')
      await page
        .getByLabel('Assigned class and section', { exact: true })
        .selectOption(platformApp.records.classId);
    await expect(page.getByRole('status', { name: 'Loading records' })).toHaveCount(0);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(
      results.violations.filter((v) => ['serious', 'critical'].includes(v.impact || '')),
    ).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    if (path === '/teacher/classroom')
      await page.screenshot({
        path: `tmp/qa/teacher-classroom-${info.project.name}.png`,
        fullPage: true,
      });
  }
});

test('Only the designated Class Teacher gets the official marks entry and CSV workflow', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  const f = platformApp.records;
  const admin = (path: string, method = 'GET', body?: unknown) =>
    platformApp.request(path, method, body, f.admin, f.schoolA);
  const replacement = await admin('/resources/teachers', 'POST', {
    staff_code: 'REPLACEMENT_CT',
    full_name: 'Replacement Class Teacher',
    staff_role: 'teacher',
  });
  expect(replacement.status).toBe(201);
  expect(
    (
      await admin('/resources/classes/' + f.classId, 'PATCH', {
        class_teacher_id: replacement.body.id,
      })
    ).status,
  ).toBe(200);
  // Other tests may designate this teacher for another class; this one must disappear.
  const assigned = (await admin('/resources/classes')).body.data;
  for (const c of assigned.filter((r: any) => r.class_teacher_id === f.teacherId)) {
    expect(
      (
        await admin('/resources/classes/' + c.id, 'PATCH', {
          class_teacher_id: replacement.body.id,
        })
      ).status,
    ).toBe(200);
  }
  await page.goto(authAppURL + '/teacher/official-results');
  await expect(
    page.getByRole('heading', { name: 'No Class Teacher designation', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enter marks', exact: true })).toHaveCount(0);
  const teacher = (await admin('/resources/teachers')).body.data.find(
    (t: any) => t.user_id === f.teacher,
  );
  expect(
    (await admin('/resources/classes/' + f.classId, 'PATCH', { class_teacher_id: teacher.id }))
      .status,
  ).toBe(200);
  const exam = await admin('/resources/exams', 'POST', {
    class_id: f.classId,
    name: 'Official browser examination',
    exam_type: 'FINAL',
    max_score: 100,
    status: 'OPEN',
  });
  expect(exam.status).toBe(201);
  await page.reload();
  await page.getByLabel('Assigned class and section', { exact: true }).selectOption(f.classId);
  const row = page.getByRole('row').filter({ hasText: 'Official browser examination' });
  await row.getByRole('button', { name: 'Enter marks', exact: true }).click();
  await page.getByRole('button', { name: 'Add marks', exact: true }).click();
  await fill(page, { student_id: f.student, subject_id: f.subject, score: '89' });
  await save(page);
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await row.getByRole('button', { name: 'Upload marks CSV', exact: true }).click();
  await page.getByLabel('Marks CSV').setInputFiles({
    name: 'official-marks.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      'student_code,subject_code,score,remarks\nSTU001,MAT,92,Class Teacher official CSV',
    ),
  });
  await page.getByRole('button', { name: 'Import marks', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(
    (await admin('/resources/exams/' + exam.body.id, 'PATCH', { status: 'LOCKED' })).status,
  ).toBe(200);
  await page.reload();
  await page.getByLabel('Assigned class and section', { exact: true }).selectOption(f.classId);
  await row.getByRole('button', { name: 'View marks', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Class Teacher official CSV');
  await expect(page.getByRole('button', { name: 'Add marks', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(row.getByRole('button', { name: 'Upload marks CSV', exact: true })).toBeDisabled();
  expect(
    (
      await admin('/resources/classes/' + f.classId, 'PATCH', {
        class_teacher_id: replacement.body.id,
      })
    ).status,
  ).toBe(200);
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'No Class Teacher designation', exact: true }),
  ).toBeVisible();
});
