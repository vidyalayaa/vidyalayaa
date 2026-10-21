import { expect } from '@playwright/test';
import { test } from './fixtures/school-admin-app';
test('School Admin assigns multiple classes and subjects then designates an assigned Class Teacher', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  const f = platformApp.records,
    admin = (path: string, method = 'GET', body?: unknown) =>
      platformApp.request(path, method, body, f.admin, f.schoolA);
  const teacher = (await admin('/resources/teachers')).body.data.find(
    (t: any) => t.user_id === f.teacher,
  );
  const subject = await admin('/resources/subjects', 'POST', {
    code: 'MULTI_ENGLISH',
    name: 'English assignment',
  });
  expect(subject.status).toBe(201);
  const otherClass = await admin('/resources/classes', 'POST', {
    academic_session_id: f.session,
    grade: '9',
    section: 'B',
    class_teacher_id: teacher.id,
  });
  expect(otherClass.status).toBe(201);
  for (const [cid, sid] of [
    [f.classId, subject.body.id],
    [otherClass.body.id, f.subject],
  ]) {
    await page.goto(authAppURL + '/admin/r/teacher_class_assignments');
    await page.getByRole('button', { name: 'Add record', exact: true }).click();
    await page.locator('#teacher_id').selectOption(teacher.id);
    await page.locator('#class_id').selectOption(cid);
    await page.locator('#subject_id').selectOption(sid);
    await page.locator('#starts_on').fill('2026-01-01');
    await page.getByRole('button', { name: 'Save record', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  await page.goto(authAppURL + '/admin/r/classes');
  const row = page.getByRole('row').filter({ hasText: '8' }).filter({ hasText: 'A' }).first();
  await row.getByRole('button', { name: /^Edit / }).click();
  await expect(page.locator('#class_teacher_id')).toContainText('Teacher Test');
  await page.locator('#class_teacher_id').selectOption(teacher.id);
  await page.getByRole('button', { name: 'Save record', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await admin('/resources/classes/' + f.classId)).body.class_teacher_id).toBe(teacher.id);
  const assignments = await admin('/resources/teacher_class_assignments');
  expect(assignments.body.data.filter((r: any) => r.teacher_id === teacher.id)).toHaveLength(3);
});
