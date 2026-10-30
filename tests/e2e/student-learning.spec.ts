import { expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { test } from './fixtures/timetable-role-app';
import { studentLearningScenario } from '../helpers/student-learning';

test.use({ timetableRole: 'student' });
test.setTimeout(120000);
test('student academics and published results stay private, combine class details and support publication, historical marks and graphs', async ({
  page,
  authAppURL,
  platformApp,
}, testInfo) => {
  await page.goto(authAppURL + '/student/r/marks');
  await expect(
    page.getByRole('heading', { name: 'No published results in this selection', exact: true }),
  ).toBeVisible();
  await expect(page.locator('main')).toContainText('School Admin must publish');
  await expect(page.locator('main')).not.toContainText('Add your first record');
  const f = platformApp.records,
    s = await studentLearningScenario(platformApp.db, f);
  await page.goto(authAppURL + '/student/r/classes?student_id=' + crypto.randomUUID());
  await expect(page.getByRole('heading', { name: 'Academics', exact: true })).toBeVisible();
  const section = page.getByRole('region', { name: 'Class 8 · Section A', exact: true });
  await expect(section).toContainText('Test year');
  await expect(section).toContainText('Class Teacher');
  await expect(section).toContainText('Teacher Test');
  await expect(section.getByRole('heading', { name: 'Subjects', exact: true })).toBeVisible();
  await expect(section).toContainText('Mathematics');
  await expect(page.locator('main')).not.toContainText('Private subject');
  await expect(page.locator('main')).not.toContainText('Earlier subject');
  await expect(page.getByRole('link', { name: 'Academic Sessions', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Add|Edit|Delete|Import|Assign/ })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const axe = await new AxeBuilder({ page }).include('main').analyze();
  expect(axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact || ''))).toEqual(
    [],
  );
  await page.screenshot({ path: testInfo.outputPath('student-academics.png'), fullPage: true });
  for (const path of [
    '/student/r/subjects',
    '/student/r/academic_sessions',
    '/student/academics',
  ]) {
    await page.goto(authAppURL + path);
    await expect(page.getByRole('heading', { name: 'Academics', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Mathematics', exact: true })).toBeVisible();
  }
  await page.goto(authAppURL + '/student/r/marks?student_id=' + s.otherStudent);
  await expect(page.getByRole('heading', { name: 'My results', exact: true })).toBeVisible();
  const table = page.getByRole('table', { name: 'My published marks', exact: true });
  await expect(table).toContainText('Zero score assessment');
  await expect(table).toContainText('0 / 100');
  await expect(table).toContainText('Earlier published assessment');
  await expect(table).toContainText('Earlier subject');
  await expect(table).not.toContainText('Current assessment');
  await expect(table).not.toContainText('Locked assessment');
  await expect(table).not.toContainText('Private');
  await expect(
    page.getByRole('heading', { name: 'Subject performance', exact: true }),
  ).toBeVisible();
  await page.getByLabel('Result subject', { exact: true }).selectOption(s.pastSubject);
  await expect(table).toContainText('65 / 100');
  await expect(table).not.toContainText('Zero score assessment');
  await page.getByLabel('Result subject', { exact: true }).selectOption('');
  const published = await platformApp.request(
    '/resources/exams/' + s.ids['Current assessment'],
    'PATCH',
    { status: 'PUBLISHED' },
    f.admin,
    f.schoolA,
  );
  expect(published.status, JSON.stringify(published.body)).toBe(200);
  await page.getByRole('button', { name: 'Refresh results', exact: true }).click();
  await expect(table).toContainText('Current assessment');
  await expect(table).toContainText('91 / 100');
  await expect(table).not.toContainText('99 / 100');
  await page
    .getByLabel('Result examination', { exact: true })
    .selectOption(s.ids['Current assessment']);
  await expect(table.getByRole('row')).toHaveCount(2);
  await expect(page.getByRole('button', { name: /Add record|Edit|Import CSV|Delete/ })).toHaveCount(
    0,
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('student-results.png'), fullPage: true });
});
