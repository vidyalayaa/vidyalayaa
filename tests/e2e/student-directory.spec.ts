import { expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { test } from './fixtures/school-admin-app';
test.setTimeout(120000);
async function fill(page: Page, values: Record<string, string>) {
  for (const [id, value] of Object.entries(values)) {
    const control = page.getByRole('dialog').last().locator(`[id="${id}"]`);
    if ((await control.evaluate((e) => e.tagName)) === 'SELECT') {
      await expect(control).toBeEnabled();
      if (id === 'class_id' && !(await control.locator(`option[value="${value}"]`).count()))
        await page.getByLabel('Find class and section', { exact: true }).fill('8 A');
      await control.selectOption(value);
    } else await control.fill(value);
  }
}
test('School Admin saves student, class and multiple guardians in one form and opens the full profile', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  const f = platformApp.records;
  await page.goto(authAppURL + '/admin/r/students');
  await page.getByRole('button', { name: 'Add student', exact: true }).click();
  await fill(page, {
    student_code: 'ONE_FORM',
    first_name: 'Connected',
    last_name: 'Learner',
    email: 'connected@example.test',
    date_of_birth: '2013-04-05',
    gender: 'FEMALE',
    class_id: f.classId,
    roll_number: '42',
    starts_on: '2026-01-01',
    'parent-0-full_name': 'Connected Mother',
    'parent-0-email': 'mother-connected@example.test',
    'parent-0-phone': '9876543210',
    'parent-0-relationship': 'MOTHER',
  });
  await page.getByRole('button', { name: 'Add another parent', exact: true }).click();
  await fill(page, {
    'parent-1-mode': 'existing',
    'parent-1-id': f.parentId,
    'parent-1-relationship': 'FATHER',
  });
  await expect(page.getByRole('button', { name: 'Add another parent', exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole('combobox', { name: 'Gender', exact: true })).toHaveValue('FEMALE');
  const axe = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
  expect(axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact || ''))).toEqual(
    [],
  );
  await page.getByRole('button', { name: 'Save student & family', exact: true }).click();
  const profile = page.getByRole('dialog');
  await expect(
    profile.getByRole('heading', { name: 'Connected Learner', exact: true }).first(),
  ).toBeVisible();
  await expect(profile).toContainText('Connected Mother');
  await expect(profile).toContainText('Parent Test');
  await expect(profile).toContainText('connected@example.test');
  await expect(profile).toContainText('Roll #42');
  await expect(profile).toContainText('Female');
  const rows = await platformApp.request(
    '/resources/students?search=ONE_FORM',
    'GET',
    undefined,
    f.admin,
    f.schoolA,
  );
  expect(rows.body.total).toBe(1);
  expect(rows.body.data[0].gender).toBe('FEMALE');
  const family = await platformApp.request(
    '/resources/student_parents?student_id=' + rows.body.data[0].id,
    'GET',
    undefined,
    f.admin,
    f.schoolA,
  );
  expect(family.body.total).toBe(2);
  await profile.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page
    .locator('summary')
    .filter({ has: page.getByRole('heading', { name: 'Class 8', exact: true }) })
    .click();
  const card = page.getByRole('article', { name: 'Student ONE_FORM', exact: true });
  await expect(card).toContainText('Connected Learner');
  await expect(card).toContainText('42');
  await card.getByRole('button', { name: /^Connected Learner / }).click();
  await expect(page.getByRole('dialog')).toContainText('Connected Mother');
  await page
    .getByRole('button', { name: 'Edit parent details for Connected Mother', exact: true })
    .click();
  await fill(page, { full_name: 'Connected Mother updated', email: 'mother-updated@example.test' });
  await page
    .getByRole('dialog')
    .last()
    .getByRole('button', { name: 'Save record', exact: true })
    .click();
  await expect(page.getByRole('dialog', { name: 'Edit parent details', exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(page.getByRole('dialog')).toContainText('mother-updated@example.test');
  await page
    .getByRole('button', {
      name: 'Edit connection for Connected Mother updated',
      exact: true,
    })
    .click();
  await fill(page, { relationship: 'OTHER' });
  await page.getByRole('dialog').last().locator('#can_receive_alerts').uncheck();
  await page
    .getByRole('dialog')
    .last()
    .getByRole('button', { name: 'Save record', exact: true })
    .click();
  await expect(
    page.getByRole('dialog', { name: 'Edit family connection', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(1);
  const savedLinks = (
    await platformApp.request(
      '/resources/student_parents?student_id=' + rows.body.data[0].id,
      'GET',
      undefined,
      f.admin,
      f.schoolA,
    )
  ).body.data;
  expect(savedLinks.find((l: any) => l.parent_id !== f.parentId)).toMatchObject({
    relationship: 'OTHER',
    can_receive_alerts: false,
  });
  await page.getByRole('dialog').getByRole('button', { name: 'Close dialog', exact: true }).click();
  await card.getByRole('button', { name: 'Edit student', exact: true }).click();
  await fill(page, { first_name: 'Connected Updated', gender: 'MALE' });
  await page.getByRole('button', { name: 'Save record', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await card.click();
  await expect(page.getByRole('dialog')).toContainText('Male');
  await expect(page.getByRole('dialog')).toContainText('Connected Updated Learner');
  await expect(page.getByRole('dialog')).toContainText('Connected Mother updated');
  const profileAxe = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
  expect(
    profileAxe.violations.filter((v) => ['serious', 'critical'].includes(v.impact || '')),
  ).toEqual([]);
});
test('School Admin legacy student, parent and family URLs return to the class-wise workspace', async ({
  page,
  authAppURL,
  isMobile,
}) => {
  for (const path of [
    '/admin/r/students?view=records',
    '/admin/r/parents',
    '/admin/r/student_parents',
  ]) {
    await page.goto(authAppURL + path);
    await expect(page).toHaveURL(authAppURL + '/admin/r/students');
    await expect(page.getByRole('heading', { name: 'Class 8', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'All student records', exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByRole('link', { name: 'Parents & Guardians', exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByRole('link', { name: 'Family Connections', exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByRole('button', { name: 'Add record', exact: true })).toHaveCount(0);
  }
  if (isMobile) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(nav.getByRole('link', { name: 'Parents', exact: true })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Family links', exact: true })).toHaveCount(0);
  await page.goto(authAppURL + '/admin/r/students?view=records&search=STU001');
  await expect(page).toHaveURL(authAppURL + '/admin/r/students?search=STU001');
  await page
    .locator('summary')
    .filter({ has: page.getByRole('heading', { name: 'Class 8', exact: true }) })
    .click();
  await page.getByRole('article', { name: 'Student STU001', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Test learner');
  await expect(page.getByRole('dialog')).toContainText('Parent Test');
  await page.getByRole('dialog').getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page
    .getByRole('article', { name: 'Student STU001', exact: true })
    .getByRole('button', { name: /^Test learner / })
    .press('Enter');
  await expect(page.getByRole('dialog')).toContainText('Parent Test');
});
test('Student classes group sections and load complete, scoped rosters only when expanded', async ({
  page,
  authAppURL,
  platformApp,
}, testInfo) => {
  const f = platformApp.records,
    admin = (path: string, method = 'GET', body?: unknown) =>
      platformApp.request(path, method, body, f.admin, f.schoolA);
  const c = await admin('/resources/classes', 'POST', {
    academic_session_id: f.session,
    grade: '8',
    section: 'DIRECTORY_B',
    class_teacher_id: f.teacherId,
  });
  const s = await admin('/resources/students', 'POST', {
    student_code: 'DIRECTORY_B_STUDENT',
    first_name: 'Section B learner',
  });
  expect(
    (
      await admin('/resources/enrollments', 'POST', {
        student_id: s.body.id,
        class_id: c.body.id,
        academic_session_id: f.session,
        starts_on: '2026-01-01',
      })
    ).status,
  ).toBe(201);
  const pageTeacher = await admin('/resources/teachers', 'POST', {
    staff_code: 'DIRECTORY_PAGE_TEACHER',
    full_name: 'Directory pagination teacher',
  });
  expect(pageTeacher.status).toBe(201);
  await platformApp.db.query("SELECT set_config('app.school_id',$1,false)", [f.schoolA]);
  try {
    await platformApp.db.query(
      "INSERT INTO classes(school_id,academic_session_id,grade,section,class_teacher_id) SELECT $1,$2,'12','DIRECTORY_'||n,$3 FROM generate_series(1,102) n",
      [f.schoolA, f.session, pageTeacher.body.id],
    );
  } finally {
    await platformApp.db.query("SELECT set_config('app.school_id','',false)");
  }
  const rosters: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/student-directory/students?')) rosters.push(r.url());
  });
  await page.goto(authAppURL + '/admin/r/students');
  await expect(
    page
      .locator('summary')
      .filter({ has: page.getByRole('heading', { name: 'Class 12', exact: true }) }),
  ).toContainText('102 sections');
  expect(rosters).toHaveLength(0);
  await page
    .locator('summary')
    .filter({ has: page.getByRole('heading', { name: 'Class 8', exact: true }) })
    .click();
  const a = page.getByRole('region', { name: 'Students in Class 8 Section A', exact: true }),
    b = page.getByRole('region', { name: 'Students in Class 8 Section DIRECTORY_B', exact: true });
  await expect(a.getByRole('article', { name: 'Student STU001', exact: true })).toBeVisible();
  await expect(
    b.getByRole('article', { name: 'Student DIRECTORY_B_STUDENT', exact: true }),
  ).toBeVisible();
  await expect(a).not.toContainText('Section B learner');
  await expect(b).not.toContainText('Test learner');
  const axe = await new AxeBuilder({ page }).include('main').analyze();
  expect(axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact || ''))).toEqual(
    [],
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `tmp/qa/student-directory-${testInfo.project.name}.png`,
    fullPage: true,
  });
});
test('Student form preserves private drafts on cancel and rejects an existing parent email without partial records', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  const f = platformApp.records;
  await page.goto(authAppURL + '/admin/r/students');
  await page.getByRole('button', { name: 'Add student', exact: true }).click();
  await fill(page, {
    student_code: 'DUPLICATE_FAMILY',
    first_name: 'Private draft',
    class_id: f.classId,
    starts_on: '2026-01-01',
    'parent-0-full_name': 'Existing Parent',
    'parent-0-email': 'parent@example.invalid',
  });
  page.once('dialog', (d) => d.dismiss());
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Add student', exact: true }).click();
  await expect(page.locator('#first_name')).toHaveValue('Private draft');
  await expect(page.locator('#parent-0-email')).toHaveValue('parent@example.invalid');
  expect(
    await page.evaluate(() => Object.keys(sessionStorage).some((k) => k.includes('draft.'))),
  ).toBe(false);
  await page.getByRole('button', { name: 'Save student & family', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Select the existing parent');
  expect(
    (
      await platformApp.request(
        '/resources/students?search=DUPLICATE_FAMILY',
        'GET',
        undefined,
        f.admin,
        f.schoolA,
      )
    ).body.total,
  ).toBe(0);
  await fill(page, { 'parent-0-mode': 'existing', 'parent-0-id': f.parentId });
  await page.getByRole('button', { name: 'Save student & family', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Parent Test');
});
