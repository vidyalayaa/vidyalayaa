import { expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { test } from './fixtures/school-admin-app';

async function fill(page: Page, values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    const control = page.getByRole('dialog').last().locator(`[id="${key}"]`);
    if ((await control.evaluate((e) => e.tagName)) === 'SELECT') await control.selectOption(value);
    else await control.fill(value);
  }
}
async function save(page: Page, closes = true) {
  await page
    .getByRole('dialog')
    .last()
    .getByRole('button', { name: 'Save record', exact: true })
    .click();
  if (closes) await expect(page.getByRole('dialog')).toHaveCount(0);
}
async function expand(page: Page, grade: string, section: string) {
  const group = page.getByRole('region', { name: `Class ${grade} · Test year`, exact: true });
  const details = group
    .locator('details')
    .filter({ has: page.locator('summary').filter({ hasText: `Section ${section}` }) });
  if (!(await details.evaluate((e) => (e as HTMLDetailsElement).open)))
    await details.locator('summary').click();
  return group.getByRole('region', { name: `Class ${grade} · Section ${section}`, exact: true });
}

test('Academics groups classes and sections with correctly scoped subjects, students and Class Teacher', async ({
  page,
  authAppURL,
  platformApp,
  isMobile,
}) => {
  test.setTimeout(120000);
  const f = platformApp.records;
  const admin = (path: string, method = 'GET', body?: unknown) =>
    platformApp.request(path, method, body, f.admin, f.schoolA);
  const teacher = await admin('/resources/teachers', 'POST', {
    staff_code: 'ACA_VIEW_T2',
    full_name: 'View second teacher',
  });
  const second = await admin('/resources/classes', 'POST', {
    academic_session_id: f.session,
    grade: '8',
    section: 'VIEW_B',
    class_teacher_id: teacher.body.id,
  });
  const sub = await admin('/resources/subjects', 'POST', {
    code: 'ACA_VIEW_ENG',
    name: 'View English',
  });
  for (const [cid, sid, tid] of [
    [second.body.id, sub.body.id, teacher.body.id],
    [f.classId, f.subject, teacher.body.id],
  ])
    expect(
      (
        await admin('/resources/teacher_class_assignments', 'POST', {
          class_id: cid,
          subject_id: sid,
          teacher_id: tid,
          starts_on: '2026-01-01',
        })
      ).status,
    ).toBe(201);
  const learner = await admin('/resources/students', 'POST', {
    student_code: 'ACA_VIEW_B',
    first_name: 'View section B learner',
  });
  expect(
    (
      await admin('/resources/enrollments', 'POST', {
        student_id: learner.body.id,
        class_id: second.body.id,
        academic_session_id: f.session,
        starts_on: '2026-01-01',
      })
    ).status,
  ).toBe(201);
  await page.goto(authAppURL + '/admin');
  if (isMobile) await page.getByRole('button', { name: 'Open navigation' }).click();
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Academics', exact: true })
    .click();
  await expect(page).toHaveURL(/\/admin\/academics$/);
  await expect(page.getByRole('heading', { name: 'Class 8', exact: true })).toHaveCount(1);
  const group = page.getByRole('region', { name: 'Class 8 · Test year', exact: true });
  await expect(group.locator('summary')).toHaveCount(2);
  const first = await expand(page, '8', 'A');
  await expect(
    first.getByRole('article', { name: 'Subject Mathematics', exact: true }),
  ).toContainText('Teacher Test');
  await expect(
    first.getByRole('article', { name: 'Subject Mathematics', exact: true }),
  ).toContainText('View second teacher');
  await expect(
    first.getByRole('heading', { name: 'Enrolled students · 1', exact: true }),
  ).toBeVisible();
  await expect(first).toContainText('Test learner');
  await expect(first).not.toContainText('View section B learner');
  const other = await expand(page, '8', 'VIEW_B');
  await expect(other).toContainText('View English');
  await expect(other).toContainText('View section B learner');
  await expect(other).not.toContainText('Test learner');
  await expect(
    other.getByRole('article', { name: 'Subject Mathematics', exact: true }),
  ).toHaveCount(0);
  await page.getByLabel('Find academic class').fill('Section VIEW_B');
  await expect(group.locator('summary')).toHaveCount(1);
  await page.getByLabel('Find academic class').fill('Class 8');
  await expect(group.locator('summary')).toHaveCount(2);
  expect((await admin('/resources/subjects?search=ACA_VIEW_ENG')).body.total).toBe(1);
  await page.getByRole('link', { name: 'Academic sessions', exact: true }).click();
  await page.getByRole('link', { name: 'Classes & Sections', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/academics$/);
});

test('School Admin creates and edits sections and designates a Class Teacher in Academics', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  test.setTimeout(120000);
  const f = platformApp.records,
    admin = (path: string, method = 'GET', body?: unknown) =>
      platformApp.request(path, method, body, f.admin, f.schoolA);
  const teacher = await admin('/resources/teachers', 'POST', {
    staff_code: 'ACA_CRUD_T2',
    full_name: 'CRUD designated teacher',
  });
  await page.goto(authAppURL + '/admin/academics');
  await page.getByRole('button', { name: 'Add class & section', exact: true }).click();
  await fill(page, {
    academic_session_id: f.session,
    grade: '6',
    section: 'CRUD_A',
    class_teacher_id: f.teacherId,
  });
  await save(page);
  const c = (await admin('/resources/classes?search=CRUD_A')).body.data[0];
  await page
    .getByRole('button', { name: 'Add section to Class 6 · Test year', exact: true })
    .click();
  await fill(page, { section: 'CRUD_B', class_teacher_id: teacher.body.id });
  await save(page);
  const region = await expand(page, '6', 'CRUD_A');
  await region.getByRole('button', { name: 'Edit class & section', exact: true }).click();
  await fill(page, { section: 'CRUD_A_EDIT' });
  await save(page);
  const renamed = await expand(page, '6', 'CRUD_A_EDIT');
  await renamed.getByRole('button', { name: 'Designate Class Teacher', exact: true }).click();
  await fill(page, { class_teacher_id: teacher.body.id });
  await save(page);
  await expect(page.locator('summary').filter({ hasText: 'Section CRUD_A_EDIT' })).toContainText(
    'Class Teacher: CRUD designated teacher',
  );
  expect((await admin('/resources/classes/' + c.id)).body.class_teacher_id).toBe(teacher.body.id);
  expect((await admin('/resources/classes?search=CRUD_A_EDIT')).body.total).toBe(1);
});

test('School Admin manages catalogue subjects and subject teachers inside the selected section', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  test.setTimeout(120000);
  const f = platformApp.records,
    admin = (path: string, method = 'GET', body?: unknown) =>
      platformApp.request(path, method, body, f.admin, f.schoolA);
  const c = await admin('/resources/classes', 'POST', {
    academic_session_id: f.session,
    grade: '5',
    section: 'SUBJECT_CRUD',
    class_teacher_id: f.teacherId,
  });
  const teacher = await admin('/resources/teachers', 'POST', {
    staff_code: 'ACA_SUB_T2',
    full_name: 'Second subject teacher',
  });
  await page.goto(authAppURL + '/admin/academics');
  const region = await expand(page, '5', 'SUBJECT_CRUD');
  await region.getByRole('button', { name: 'Add subject & teacher', exact: true }).click();
  await page.getByRole('dialog').locator('#subject-source').selectOption('new');
  await fill(page, { code: 'ACA_UI_SUB', name: 'Website class subject' });
  await expect(
    page.getByRole('dialog').getByRole('button', { name: 'Save subject & teacher', exact: true }),
  ).toBeDisabled();
  expect((await admin('/resources/subjects?search=ACA_UI_SUB')).body.total).toBe(0);
  await fill(page, { teacher_id: f.teacherId, starts_on: '2026-01-01' });
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Save subject & teacher', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const sub = (await admin('/resources/subjects?search=ACA_UI_SUB')).body.data[0];
  const card = region.getByRole('article', { name: 'Subject Website class subject', exact: true });
  await expect(card).toContainText('Teacher Test');
  await card
    .getByRole('button', { name: 'Edit subject Website class subject', exact: true })
    .click();
  await fill(page, { name: 'Edited website class subject' });
  await save(page);
  const edited = region.getByRole('article', {
    name: 'Subject Edited website class subject',
    exact: true,
  });
  await edited.getByRole('button', { name: 'Assign another teacher', exact: true }).click();
  await fill(page, { teacher_id: teacher.body.id, starts_on: '2026-01-01' });
  await save(page);
  await expect(edited).toContainText('Second subject teacher');
  await edited
    .getByRole('button', {
      name: 'Edit Edited website class subject assignment for Second subject teacher',
      exact: true,
    })
    .click();
  await fill(page, { ends_on: '2027-12-31' });
  await save(page);
  await expect(edited).toContainText('2027-12-31');
  const assignments = (await admin(`/academics/classes/${c.body.id}/subjects`)).body;
  expect(assignments.total).toBe(1);
  expect(assignments.data[0].teachers).toHaveLength(2);
  for (const name of ['Second subject teacher', 'Teacher Test']) {
    await edited
      .getByRole('button', {
        name: `Archive Edited website class subject assignment for ${name}`,
        exact: true,
      })
      .click();
    await page
      .getByRole('dialog')
      .locator('#action-reason')
      .fill('Remove this section assignment while retaining history');
    await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  await expect(
    region.getByRole('heading', { name: 'No subject assignments yet', exact: true }),
  ).toBeVisible();
  expect((await admin('/resources/subjects/' + sub.id)).body.name).toBe(
    'Edited website class subject',
  );
});

test('School Admin can cancel a new section subject or reuse an existing subject with its required teacher', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  const f = platformApp.records;
  const admin = (path: string, method = 'GET', body?: unknown) =>
    platformApp.request(path, method, body, f.admin, f.schoolA);
  const c = await admin('/resources/classes', 'POST', {
    academic_session_id: f.session,
    grade: '4',
    section: 'EXISTING_SUB',
    class_teacher_id: f.teacherId,
  });
  expect(c.status).toBe(201);
  await page.goto(authAppURL + '/admin/academics');
  const region = await expand(page, '4', 'EXISTING_SUB');
  await region.getByRole('button', { name: 'Add subject & teacher', exact: true }).click();
  await page.getByRole('dialog').locator('#subject-source').selectOption('new');
  await fill(page, { code: 'CANCEL_SECTION_SUB', name: 'Cancelled section subject' });
  page.once('dialog', (d) => d.accept());
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await admin('/resources/subjects?search=CANCEL_SECTION_SUB')).body.total).toBe(0);
  await region.getByRole('button', { name: 'Add subject & teacher', exact: true }).click();
  await expect(page.getByRole('dialog').locator('#name')).toHaveValue('Cancelled section subject');
  await page.getByRole('dialog').locator('#subject-source').selectOption('existing');
  await fill(page, { subject_id: f.subject, teacher_id: f.teacherId, starts_on: '2026-01-01' });
  const accessibility = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
  expect(
    accessibility.violations.filter((v) => ['serious', 'critical'].includes(v.impact || '')),
  ).toEqual([]);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Save subject & teacher', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    region.getByRole('article', { name: 'Subject Mathematics', exact: true }),
  ).toContainText('Teacher Test');
  const assigned = (await admin(`/academics/classes/${c.body.id}/subjects`)).body;
  expect(assigned.total).toBe(1);
  expect(assigned.data[0].teachers.map((t: any) => t.class_id)).toEqual([c.body.id]);
  expect(
    (await admin('/resources/subjects?search=MAT')).body.data.filter(
      (s: any) => s.id === f.subject,
    ),
  ).toHaveLength(1);
});

test('School Admin enrolls, edits, ends and reviews student history without leaving the section', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  test.setTimeout(120000);
  const f = platformApp.records,
    admin = (path: string, method = 'GET', body?: unknown) =>
      platformApp.request(path, method, body, f.admin, f.schoolA);
  const c = await admin('/resources/classes', 'POST', {
    academic_session_id: f.session,
    grade: '4',
    section: 'ENROLL_CRUD',
    class_teacher_id: f.teacherId,
  });
  const student = await admin('/resources/students', 'POST', {
    student_code: 'ACA_UI_ENROLL',
    first_name: 'Website enrolled learner',
  });
  await page.goto(authAppURL + '/admin/academics');
  const region = await expand(page, '4', 'ENROLL_CRUD');
  await region.getByRole('button', { name: 'Enroll student', exact: true }).click();
  await fill(page, { student_id: student.body.id, starts_on: '2026-01-01', roll_number: '41' });
  await save(page);
  await expect(
    region.getByRole('heading', { name: 'Enrolled students · 1', exact: true }),
  ).toBeVisible();
  await region
    .getByRole('button', { name: 'Edit enrollment for Website enrolled learner', exact: true })
    .click();
  await fill(page, { roll_number: '42', status: 'ENDED', ends_on: '2026-10-21' });
  await save(page);
  await expect(
    region.getByRole('heading', { name: 'Enrolled students · 0', exact: true }),
  ).toBeVisible();
  await region.getByLabel('Enrollment view', { exact: true }).selectOption('all');
  await expect(region).toContainText('Website enrolled learner');
  await expect(region).toContainText('42');
  await region.getByRole('button', { name: 'Archive section', exact: true }).click();
  await page
    .getByRole('dialog')
    .locator('#action-reason')
    .fill('Archive section while keeping enrollment history');
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('summary').filter({ hasText: 'Section ENROLL_CRUD' })).toHaveCount(0);
  expect(
    (await platformApp.db.query('SELECT id FROM enrollments WHERE class_id=$1', [c.body.id])).rows,
  ).toHaveLength(1);
});

test('Academics loads classes beyond the first hundred and has accessible responsive expandable sections', async ({
  page,
  authAppURL,
  platformApp,
}, testInfo) => {
  test.setTimeout(120000);
  const f = platformApp.records;
  await platformApp.db.query("SELECT set_config('app.school_id',$1,false)", [f.schoolA]);
  try {
    await platformApp.db.query(
      "INSERT INTO classes(school_id,academic_session_id,grade,section,class_teacher_id) SELECT $1,$2,'12','PAGE_'||n,$3 FROM generate_series(1,103) n",
      [f.schoolA, f.session, f.teacherId],
    );
  } finally {
    await platformApp.db.query("SELECT set_config('app.school_id','',false)");
  }
  await page.goto(authAppURL + '/admin/academics');
  const group = page.getByRole('region', { name: 'Class 12 · Test year', exact: true });
  await expect(group.locator('summary')).toHaveCount(103);
  await page.getByLabel('Find academic class').fill('Section PAGE_103');
  await expect(page.locator('summary')).toHaveCount(1);
  await group.locator('summary').click();
  await expect(
    group.getByRole('heading', { name: 'No subject assignments yet', exact: true }),
  ).toBeVisible();
  const result = await new AxeBuilder({ page }).include('main').analyze();
  expect(result.violations.filter((v) => ['critical', 'serious'].includes(v.impact || ''))).toEqual(
    [],
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `tmp/qa/academics-${testInfo.project.name}.png`, fullPage: true });
  for (const role of [f.teacher, f.principal, f.parent, f.studentUser])
    expect(
      (await platformApp.request('/academics/classes', 'GET', undefined, role, f.schoolA)).status,
    ).toBe(403);
});
