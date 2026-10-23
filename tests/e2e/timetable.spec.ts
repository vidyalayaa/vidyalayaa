import { expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { test } from './fixtures/school-admin-app';
import { saveTimingTemplate, timetableAdmin, timetableSection } from './fixtures/timetable-data';
test.setTimeout(120000);

test('School Admin configures a Monday–Saturday week with breaks, creates, edits and deletes class lectures', async ({
  page,
  authAppURL,
  platformApp,
}, testInfo) => {
  const f = platformApp.records,
    call = timetableAdmin(platformApp);
  await page.goto(authAppURL + '/admin/r/timetable_entries');
  await expect(
    page.getByRole('heading', { name: 'Your school week, clearly planned.' }),
  ).toBeVisible({ timeout: 30000 });
  await page.getByRole('button', { name: 'School timings', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('#lecture-duration').fill('45');
  await dialog.locator('#lecture-count').fill('3');
  while (await dialog.getByRole('button', { name: /^Remove break / }).count())
    await dialog
      .getByRole('button', { name: /^Remove break / })
      .first()
      .click();
  await dialog.getByRole('button', { name: 'Add break', exact: true }).click();
  await dialog.locator('#break-0-label').fill('Morning break');
  await dialog.locator('#break-0-start_time').fill('09:30');
  await dialog.locator('#break-0-end_time').fill('09:45');
  await dialog.getByRole('button', { name: 'Generate lecture times', exact: true }).click();
  await expect(dialog.locator('#period-3-start_time')).toHaveValue('09:45');
  const accessibility = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
  expect(
    accessibility.violations.filter((v) => ['serious', 'critical'].includes(v.impact || '')),
  ).toEqual([]);
  await dialog.getByRole('button', { name: 'Save school timings', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page
    .getByRole('combobox', { name: 'Class and section', exact: true })
    .selectOption(f.classId);
  for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'])
    await expect(page.getByRole('columnheader', { name: day, exact: true })).toBeVisible();
  await expect(page.getByRole('rowheader', { name: /Morning break/ })).toBeVisible();
  await page.getByRole('button', { name: 'Add lecture Wednesday Lecture 1', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('combobox', { name: 'Subject', exact: true })
    .selectOption(f.subject);
  await page
    .getByRole('dialog')
    .getByRole('combobox', { name: 'Assigned teacher', exact: true })
    .selectOption(f.teacherId);
  await page.getByRole('dialog').locator('#lecture-room').fill('101');
  await page.getByRole('dialog').getByRole('button', { name: 'Save lecture', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page.getByRole('article', { name: 'Wednesday Lecture 1: Mathematics', exact: true }),
  ).toContainText('Teacher Test');
  const saved = (await call('/timetable/classes/' + f.classId + '/entries')).body.data.find(
    (e: { weekday: number; room: string }) => e.weekday === 3 && e.room === '101',
  );
  await page.getByRole('button', { name: 'Edit lecture Wednesday Lecture 1', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('combobox', { name: 'Lecture period', exact: true })
    .selectOption('2');
  await page.getByRole('dialog').locator('#lecture-room').fill('102');
  await page.getByRole('dialog').getByRole('button', { name: 'Save lecture', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page.getByRole('article', { name: 'Wednesday Lecture 2: Mathematics', exact: true }),
  ).toContainText('Room 102');
  await page
    .getByRole('button', { name: 'Delete lecture Wednesday Lecture 2', exact: true })
    .click();
  await page.getByRole('dialog').locator('#action-reason').fill('Replace this lecture placement');
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('article', { name: /Wednesday Lecture/ })).toHaveCount(0);
  expect(
    (await platformApp.db.query('SELECT retired_at FROM timetable_entries WHERE id=$1', [saved.id]))
      .rows[0].retired_at,
  ).toBeTruthy();
  const audit = await new AxeBuilder({ page }).include('main').analyze();
  expect(audit.violations.filter((v) => ['serious', 'critical'].includes(v.impact || ''))).toEqual(
    [],
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('combobox', { name: 'Class and section', exact: true }).focus();
  await page
    .locator('section[aria-label="Weekly class timetable"] .overflow-x-auto')
    .evaluate((element) => {
      element.scrollLeft = 0;
    });
  await page.screenshot({ path: `tmp/qa/timetable-${testInfo.project.name}.png`, fullPage: true });
});

test('School Admin cannot overlap class/teacher bookings or save overlapping school breaks', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  const f = platformApp.records,
    call = timetableAdmin(platformApp);
  await saveTimingTemplate(platformApp);
  const other = await timetableSection(platformApp, 'CONFLICT', true);
  expect(
    (
      await call('/resources/timetable_entries', 'POST', {
        class_id: f.classId,
        teacher_id: f.teacherId,
        subject_id: f.subject,
        weekday: 2,
        starts_at: '08:00',
        ends_at: '08:45',
      })
    ).status,
  ).toBe(201);
  await page.goto(authAppURL + '/admin/r/timetable_entries');
  await page
    .getByRole('combobox', { name: 'Class and section', exact: true })
    .selectOption(other.classId);
  await page.getByRole('button', { name: 'Add lecture Tuesday Lecture 1', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('combobox', { name: 'Subject', exact: true })
    .selectOption(f.subject);
  await page
    .getByRole('dialog')
    .getByRole('combobox', { name: 'Assigned teacher', exact: true })
    .selectOption(f.teacherId);
  await page.getByRole('dialog').getByRole('button', { name: 'Save lecture', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('already scheduled');
  expect((await call('/timetable/classes/' + other.classId + '/entries')).body.total).toBe(0);
  await page
    .getByRole('dialog')
    .getByRole('combobox', { name: 'Lecture period', exact: true })
    .selectOption('3');
  await page.getByRole('dialog').getByRole('button', { name: 'Save lecture', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const before = (await call('/timetable/settings')).body.version;
  await page.getByRole('button', { name: 'School timings', exact: true }).click();
  await page.getByRole('dialog').locator('#break-0-start_time').fill('08:10');
  await page.getByRole('dialog').locator('#break-0-end_time').fill('08:20');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Save school timings', exact: true })
    .click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('cannot overlap');
  expect((await call('/timetable/settings')).body.version).toBe(before);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('School Admin changes school days and individual timings while preserving existing custom lectures', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  const f = platformApp.records;
  await saveTimingTemplate(platformApp);
  await platformApp.db.query(
    "INSERT INTO timetable_entries(school_id,class_id,subject_id,teacher_id,weekday,starts_at,ends_at,room) VALUES($1,$2,$3,$4,7,'14:00:30','14:40:30','Legacy hall')",
    [f.schoolA, f.classId, f.subject, f.teacherId],
  );
  await page.goto(authAppURL + '/admin/r/timetable_entries');
  await page
    .getByRole('combobox', { name: 'Class and section', exact: true })
    .selectOption(f.classId);
  await expect(page.getByRole('rowheader', { name: /Existing lecture/ })).toContainText('14:00:30');
  await page.getByRole('button', { name: 'School timings', exact: true }).click();
  await page.getByRole('dialog').getByRole('checkbox', { name: 'Saturday', exact: true }).uncheck();
  await page.getByRole('dialog').getByRole('checkbox', { name: 'Sunday', exact: true }).check();
  await page.getByRole('dialog').locator('#period-3-start_time').fill('10:00');
  await page.getByRole('dialog').locator('#period-3-end_time').fill('10:45');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Save school timings', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('columnheader', { name: 'Saturday', exact: true })).toHaveCount(0);
  await expect(page.getByRole('columnheader', { name: 'Sunday', exact: true })).toBeVisible();
  await expect(page.getByRole('rowheader', { name: /Lecture 3/ })).toContainText('10:00–10:45');
  await expect(
    page.getByRole('article', { name: 'Sunday Existing lecture: Mathematics', exact: true }),
  ).toContainText('Legacy hall');
});
