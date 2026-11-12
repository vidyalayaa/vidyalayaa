import { expect, type Locator } from '@playwright/test';
import { test } from './fixtures/school-admin-app';
import { test as familyTest } from './fixtures/family-calendar-app';
import { parentScenario } from '../helpers/parent-workspace';

async function october(calendar: Locator) {
  await calendar.getByLabel('From date', { exact: true }).fill('2026-10-01');
  await calendar.getByLabel('To date', { exact: true }).fill('2026-10-06');
  await calendar.getByRole('button', { name: 'Apply filters', exact: true }).click();
}

test('attendance calendar renders marked, unmarked and off days, with a live register link and yearly view', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  test.setTimeout(120_000);
  const f = platformApp.records;
  await platformApp.db.query(
    `INSERT INTO daily_attendance(school_id,student_id,class_id,academic_session_id,attendance_date,attendance_status)
     VALUES($1,$2,$3,$4,'2026-10-01','PRESENT'),($1,$2,$3,$4,'2026-10-02','ABSENT'),($1,$2,$3,$4,'2026-10-03','HALF_DAY')`,
    [f.schoolA, f.student, f.classId, f.session],
  );
  await platformApp.db.query(
    "INSERT INTO school_holidays(school_id,label,on_date,kind) VALUES($1,'School closure','2026-10-05','HOLIDAY')",
    [f.schoolA],
  );
  await page.goto(authAppURL + '/admin/attendance');
  const calendar = page.locator('.attendance-calendar');
  await expect(calendar.getByRole('heading', { name: 'Attendance calendar' })).toBeVisible();
  await expect(calendar.locator('[aria-current="date"]')).toHaveCount(1);
  await calendar.getByRole('button', { name: 'This Academic Year', exact: true }).click();
  await expect(calendar.getByRole('region', { name: 'Selected period' })).toBeVisible();
  await calendar.getByRole('combobox', { name: 'Class', exact: true }).selectOption('8');
  await calendar.getByRole('combobox', { name: 'Section', exact: true }).selectOption(f.classId);
  await october(calendar);
  const day = (date: string) => calendar.locator(`[data-date="${date}"]`);
  await expect(day('2026-10-01')).toHaveAttribute('data-tone', 'present');
  await expect(day('2026-10-02')).toHaveAttribute('data-tone', 'absent');
  await expect(day('2026-10-03')).toHaveAttribute('data-tone', 'partial');
  await expect(day('2026-10-04')).toHaveAccessibleName(/weekly off/i);
  await expect(day('2026-10-05')).toHaveAccessibleName(/school closure/i);
  await expect(day('2026-10-06')).toHaveAccessibleName(/unmarked/i);
  await expect(calendar.getByRole('region', { name: 'Selected period' })).toContainText('66.7%');
  await calendar
    .getByRole('combobox', { name: 'Attendance status', exact: true })
    .selectOption('ABSENT');
  await expect(day('2026-10-01')).toHaveAttribute('data-dimmed', '');
  await expect(calendar.getByRole('region', { name: 'Selected period' })).toContainText(
    '1 matching dates',
  );
  await day('2026-10-02').click();
  const dialog = page.getByRole('dialog', { name: /Attendance for/ });
  await expect(dialog).toContainText('Test learner');
  await expect(dialog).toContainText(/absent/i);
  await dialog.getByRole('button', { name: 'Open daily register' }).click();
  await expect(page.getByLabel('Attendance date', { exact: true })).toHaveValue('2026-10-02');
  await expect(page.locator('#attendance-class')).toHaveValue(f.classId);
  await calendar.getByRole('combobox', { name: 'Attendance status', exact: true }).selectOption('');
  await calendar.getByRole('button', { name: 'Yearly heatmap' }).click();
  await expect(
    calendar.getByRole('region', { name: '2026 attendance heatmap' }).locator('[data-date]'),
  ).toHaveCount(365);
  await expect(day('2026-10-02')).toHaveAccessibleName(/0% attendance/);
  await expect(day('2026-10-01')).toHaveAttribute('data-tone', 'full');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(day('2026-10-01')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const futureYear = String(new Date().getUTCFullYear() + 1);
  await calendar.getByRole('combobox', { name: 'Calendar year' }).selectOption(futureYear);
  await expect(day(`${futureYear}-01-01`)).toHaveAccessibleName(/future date/i);
});

familyTest(
  'parent calendar switches linked children and rejects a private child',
  async ({ page, authAppURL, platformApp }) => {
    familyTest.setTimeout(120_000);
    const f = platformApp.records;
    const family = await parentScenario(platformApp.db, f);
    await platformApp.db.query(
      `INSERT INTO daily_attendance(school_id,student_id,class_id,academic_session_id,attendance_date,attendance_status)
     VALUES($1,$2,$4,$5,'2026-10-01','PRESENT'),($1,$3,$6,$5,'2026-10-01','ABSENT')`,
      [f.schoolA, f.student, family.sibling, f.classId, f.session, family.siblingClass],
    );
    await page.goto(authAppURL + '/parent/attendance?child_id=' + f.student);
    const calendar = page.locator('.attendance-calendar');
    await expect(page.getByRole('button', { name: /^(Record list|Calendar view)$/i })).toHaveCount(0);
    await october(calendar);
    await expect(calendar.locator('[data-date="2026-10-01"]')).toHaveAttribute(
      'data-tone',
      'present',
    );
    await expect(calendar.getByRole('combobox', { name: 'Class', exact: true })).toHaveCount(0);
    await page.getByLabel('Your child', { exact: true }).selectOption(family.sibling);
    await october(calendar);
    await expect(calendar.locator('[data-date="2026-10-01"]')).toHaveAttribute(
      'data-tone',
      'absent',
    );
    const unauthorized = await platformApp.request(
      `/parent/children/${family.privateChild}/attendance/calendar?from=2026-10-01&to=2026-10-06`,
      'GET',
      undefined,
      f.parent,
      f.schoolA,
    );
    expect(unauthorized.status).toBe(404);
  },
);
