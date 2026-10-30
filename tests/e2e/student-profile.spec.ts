import { expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { test as base } from './fixtures/timetable-role-app';
import { studentProfileScenario } from '../helpers/student-profile';
const test = base.extend<{}, { studentProfileIsolation: void }>({
  studentProfileIsolation: [
    async ({}, use) => {
      await use();
    },
    { scope: 'worker', auto: true },
  ],
});
test.use({ timetableRole: 'student', timezoneId: 'America/Los_Angeles' });
test.setTimeout(120000);

test('student navigation excludes assignment management, enrollment management and fees, including direct page URLs', async ({
  page,
  authAppURL,
}) => {
  await page.goto(authAppURL + '/student/r/classes');
  await expect(page.getByRole('heading', { name: 'Subjects', exact: true })).toBeVisible();
  for (const resource of ['teacher_class_assignments', 'enrollments', 'fee_records'])
    await expect(page.locator(`a[href="/student/r/${resource}"]`)).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Teacher Assignments', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Enrollments', exact: true })).toHaveCount(0);
  for (const resource of ['teacher_class_assignments', 'enrollments', 'fee_records']) {
    await page.goto(authAppURL + '/student/r/' + resource);
    await expect(
      page.getByRole('heading', { name: 'Access unavailable', exact: true }),
    ).toBeVisible();
  }
  await page.goto(authAppURL + '/student/profile');
  await expect(page.getByRole('heading', { name: 'My profile', exact: true })).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'School & current enrollment', exact: true }),
  ).toBeVisible();
});
test('students open a dedicated own-profile page with real fields, guardians and enrollment history, without administration or ID selectors', async ({
  page,
  authAppURL,
  platformApp,
}, testInfo) => {
  const s = await studentProfileScenario(platformApp.db, platformApp.records);
  await page.goto(authAppURL + '/student/profile?student_id=' + s.other);
  await expect(page.getByRole('heading', { name: 'My profile', exact: true })).toBeVisible();
  const personal = page.getByRole('region', { name: 'Personal information', exact: true });
  await expect(personal).toContainText('Aarav Sharma');
  await expect(personal).toContainText('29 February 2012');
  await expect(personal).toContainText('Male');
  const contact = page.getByRole('region', { name: 'Contact details', exact: true });
  await expect(contact).toContainText('learner@example.invalid');
  await expect(contact).toContainText('+91 90000 10000');
  await expect(
    page.getByRole('region', { name: 'School & current enrollment', exact: true }),
  ).toContainText('08-A-17');
  await expect(
    page.getByRole('region', { name: 'Parents & guardians', exact: true }),
  ).toContainText('Parent Test');
  await expect(
    page.getByRole('region', { name: 'Admission & enrollment records', exact: true }),
  ).toContainText('Earlier session');
  await expect(
    page.getByRole('region', { name: 'Profile corrections', exact: true }),
  ).toContainText('Contact your School Admin');
  await expect(page.getByRole('img', { name: 'No profile photo recorded' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: /Add student|Add record|Edit|Import|Export|Delete|Invite/i }),
  ).toHaveCount(0);
  await expect(page.locator('main input,main select,main textarea')).toHaveCount(0);
  await expect(page.locator('main')).not.toContainText('Private learner');
  await expect(page.locator('main')).not.toContainText('Private guardian');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const axe = await new AxeBuilder({ page }).include('main').analyze();
  expect(axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact || ''))).toEqual(
    [],
  );
  await page.screenshot({ path: testInfo.outputPath('student-profile.png'), fullPage: true });
  await page.goto(authAppURL + '/student/r/students?view=records&student_id=' + s.other);
  await expect(page).toHaveURL(authAppURL + '/student/profile');
  await expect(personal).toContainText('Aarav Sharma');
});
test('shows missing values and no enrollment honestly and stops showing an unlinked profile', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  const f = platformApp.records;
  await platformApp.db.query(
    "UPDATE students SET date_of_birth=NULL,gender='NOT_SPECIFIED',email=NULL,last_name=NULL WHERE id=$1",
    [f.student],
  );
  await platformApp.db.query("UPDATE enrollments SET status='ENDED' WHERE student_id=$1", [
    f.student,
  ]);
  await platformApp.db.query("UPDATE student_parents SET status='REVOKED' WHERE student_id=$1", [
    f.student,
  ]);
  await page.goto(authAppURL + '/student/profile');
  await expect(page.getByRole('region', { name: 'Personal information' })).toContainText(
    'Not specified',
  );
  await expect(page.getByRole('region', { name: 'Contact details' })).toContainText('Not recorded');
  await expect(page.getByRole('region', { name: 'School & current enrollment' })).toContainText(
    'No current enrollment',
  );
  await expect(page.getByRole('region', { name: 'Parents & guardians' })).toContainText(
    'No active parent or guardian',
  );
  await platformApp.db.query('UPDATE students SET user_id=NULL WHERE id=$1', [f.student]);
  await page.reload();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Personal information' })).toHaveCount(0);
  await platformApp.db.query('UPDATE students SET user_id=$1 WHERE id=$2', [
    f.studentUser,
    f.student,
  ]);
});
