import { expect } from '@playwright/test';
import { test } from './fixtures/family-calendar-app';
import { parentScenario } from '../helpers/parent-workspace';
test.setTimeout(120000);
test('parents switch children across every section and cannot open another family’s records', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  const f = platformApp.records,
    s = await parentScenario(platformApp.db, f);
  await page.goto(authAppURL + '/parent');
  const selector = page.getByRole('combobox', { name: 'Your child', exact: true });
  await selector.selectOption(f.student);
  await expect(page.getByRole('heading', { name: 'Student details', exact: true })).toBeVisible();
  await expect(selector.locator('option')).toHaveCount(2);
  await page.goto(authAppURL + '/parent/r/assignments');
  await expect(page.getByRole('heading', { name: 'First homework', exact: true })).toBeVisible();
  await expect(page.getByText('Private homework', { exact: true })).toHaveCount(0);
  await selector.selectOption(s.sibling);
  await expect(page.getByRole('heading', { name: 'Sibling homework', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'First homework', exact: true })).toHaveCount(0);
  await page.goto(authAppURL + '/parent/r/marks');
  await expect(selector).toHaveValue(s.sibling);
  await expect(page.getByRole('cell', { name: 'Sibling exam', exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: /Add record|Import|Manage examinations|Enter marks/i }),
  ).toHaveCount(0);
  await page.goto(authAppURL + '/parent/r/classes');
  await expect(page.getByRole('heading', { name: 'Mathematics', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Add class|Assign teacher|Edit/i })).toHaveCount(0);
  await page.goto(authAppURL + '/parent/r/fee_records');
  await expect(page.getByRole('cell', { name: 'Sibling tuition', exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: /Record payment|Assess fees|Fee structures/i }),
  ).toHaveCount(0);
  await page.goto(authAppURL + '/parent/r/announcements');
  await expect(
    page.getByRole('heading', { name: 'Sibling announcement', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'School-wide announcement', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Staff private announcement', { exact: true })).toHaveCount(0);
  const attendanceDate = (
    await platformApp.db.query<{ date: string }>(
      'SELECT attendance_date::text AS date FROM daily_attendance WHERE id=$1',
      [s.days[s.sibling]],
    )
  ).rows[0].date;
  await page.goto(authAppURL + '/parent/attendance');
  await expect(
    page.getByRole('button', { name: /Mark attendance|Class register|Manual/i }),
  ).toHaveCount(0);
  await page.getByLabel('From date', { exact: true }).fill(attendanceDate);
  await page.getByLabel('To date', { exact: true }).fill(attendanceDate);
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await page.locator(`[data-date="${attendanceDate}"]`).click();
  await page.getByRole('button', { name: 'Request correction', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /Request attendance correction/ });
  await dialog.locator('textarea').fill('Please review the arrival time for this child.');
  await dialog.getByRole('button', { name: /Save|Submit/i }).click();
  await expect(dialog).toHaveCount(0);
  await page.goto(authAppURL + '/parent/corrections');
  await expect(
    page.getByRole('cell', { name: 'Please review the arrival time for this child.', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /Approve|Reject/i })).toHaveCount(0);
  await page.goto(authAppURL + '/parent/reports');
  await page.getByRole('button', { name: 'Request child report', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('Class Id', { exact: true })).toHaveCount(0);
  await page.getByRole('dialog').getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.goto(authAppURL + '/parent/notifications');
  await expect(
    page.getByRole('button', { name: 'Enable device notifications', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /Compose|Send notification|School settings/i }),
  ).toHaveCount(0);
  await page.goto(authAppURL + '/parent/calendar');
  await expect(page.getByRole('region', { name: 'School calendar', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add event', exact: true })).toHaveCount(0);
  await page.goto(authAppURL + '/parent/r/timetable_entries');
  await expect(page.getByRole('combobox', { name: 'Class and section', exact: true })).toHaveValue(
    s.siblingClass,
  );
  await expect(page.getByRole('button', { name: /School timings|Add lecture/i })).toHaveCount(0);
  await page.goto(authAppURL + '/parent/r/students?child_id=' + s.privateChild);
  await expect(
    page.getByRole('heading', { name: 'Child access unavailable', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Other family learner', { exact: true })).toHaveCount(0);
  expect(
    (
      await platformApp.request(
        '/parent/children/' + s.privateChild + '/profile',
        'GET',
        undefined,
        f.parent,
        f.schoolA,
      )
    ).status,
  ).toBe(404);
  await platformApp.db.query("UPDATE student_parents SET status='REVOKED' WHERE student_id=$1", [
    s.sibling,
  ]);
  await page.goto(authAppURL + '/parent/r/students');
  await expect(selector.locator('option')).toHaveCount(1);
  await expect(selector).toHaveValue(f.student);
  // A platform operator may also be a parent; the parent layout must not replace
  // their separately authorized platform console.
  await platformApp.db.query(
    "INSERT INTO platform_staff(user_id,platform_role) VALUES($1,'SUPER_ADMIN')",
    [f.parent],
  );
  await page.goto(authAppURL + '/platform/schools');
  await expect(
    page.getByRole('heading', { name: 'Every school. One clear view.', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'Selected child', exact: true })).toHaveCount(0);
  await platformApp.db.query('DELETE FROM platform_staff WHERE user_id=$1', [f.parent]);
});
