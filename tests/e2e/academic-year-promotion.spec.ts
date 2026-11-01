import { expect } from '@playwright/test';
import { test } from './fixtures/timetable-role-app';
import { schoolToday, shiftDate } from '../../apps/web/src/features/calendar/calendar-utils';
test.describe('School Admin', () => {
  test.use({ timetableRole: 'school_admin' });
  test('prepares, previews and activates a new year without replacing identities or financial history', async ({
    page,
    authAppURL,
    platformApp,
  }, info) => {
    const f = platformApp.records,
      today = schoolToday('Asia/Kolkata'),
      extra = crypto.randomUUID();
    await platformApp.db.query('UPDATE academic_sessions SET ends_on=$2 WHERE id=$1', [
      f.session,
      shiftDate(today, -1),
    ]);
    await platformApp.db.query(
      "INSERT INTO classes(id,school_id,academic_session_id,grade,section,class_teacher_id) VALUES($1,$2,$3,'9','A',$4)",
      [extra, f.schoolA, f.session, f.teacherId],
    );
    await platformApp.db.query(
      "INSERT INTO teacher_class_assignments(school_id,class_id,teacher_id,subject_id,starts_on) VALUES($1,$2,$3,$4,'2026-01-01')",
      [f.schoolA, extra, f.teacherId, f.subject],
    );
    await page.goto(authAppURL + '/admin/academics');
    await page.getByRole('link', { name: 'Academic-year promotion', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Academic years', exact: true })).toBeVisible();
    await page.getByLabel('New year name', { exact: true }).fill('Next academic year');
    await page.getByRole('button', { name: 'Prepare year', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: '3. Map classes & sections', exact: true }),
    ).toBeVisible();
    await page
      .getByLabel('Destination for Class 8 A', { exact: true })
      .selectOption({ label: 'Class 9 · Section A' });
    await page.getByRole('checkbox', { name: /Generate new-year installments/ }).uncheck();
    await page.getByRole('button', { name: 'Preview promotion', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Promotion preview' })).toBeVisible();
    expect(
      (
        await platformApp.db.query('SELECT is_current FROM academic_sessions WHERE id=$1', [
          f.session,
        ])
      ).rows[0].is_current,
    ).toBe(true);
    const accountBefore = (
      await platformApp.db.query('SELECT id,user_id,student_code FROM students WHERE id=$1', [
        f.student,
      ])
    ).rows[0];
    await page.screenshot({ path: info.outputPath('promotion-preview.png'), fullPage: true });
    await page.getByLabel('Activation confirmation', { exact: true }).fill('ACTIVATE');
    await page
      .getByRole('button', { name: 'Confirm & activate academic year', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Academic year activated', exact: true }),
    ).toBeVisible();
    expect(
      (
        await platformApp.db.query('SELECT id,user_id,student_code FROM students WHERE id=$1', [
          f.student,
        ])
      ).rows[0],
    ).toEqual(accountBefore);
    expect(
      (
        await platformApp.db.query(
          "SELECT c.grade FROM enrollments e JOIN classes c ON c.id=e.class_id WHERE e.student_id=$1 AND e.status='ACTIVE'",
          [f.student],
        )
      ).rows,
    ).toEqual([{ grade: '9' }]);
    await page.getByRole('button', { name: 'View year records', exact: true }).click();
    await page.getByLabel('History academic year', { exact: true }).selectOption(f.session);
    await expect(page.getByRole('table')).toContainText('STU001');
    await expect(page.getByRole('table')).toContainText('ENDED');
    expect(
      (
        await platformApp.db.query(
          'SELECT is_current,closed_at FROM academic_sessions WHERE id=$1',
          [f.session],
        )
      ).rows[0],
    ).toMatchObject({ is_current: false });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
});
for (const role of ['teacher', 'student', 'parent', 'principal'] as const)
  test.describe(role, () => {
    test.use({ timetableRole: role });
    test('cannot enter promotion or activate a year', async ({ page, authAppURL, platformApp }) => {
      await page.goto(authAppURL + `/${role}/academic-years`);
      await expect(
        page.getByRole('heading', { name: 'Access unavailable', exact: true }),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: 'Prepare year', exact: true })).toHaveCount(0);
      const f = platformApp.records,
        user =
          role === 'teacher'
            ? f.teacher
            : role === 'student'
              ? f.studentUser
              : role === 'parent'
                ? f.parent
                : f.principal;
      expect(
        (await platformApp.request('/promotion/workspace', 'GET', undefined, user, f.schoolA))
          .status,
      ).toBe(403);
    });
  });
