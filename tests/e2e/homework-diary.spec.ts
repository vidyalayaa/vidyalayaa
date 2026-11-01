import { expect } from '@playwright/test';
import { test } from './fixtures/timetable-role-app';
import { schoolToday } from '../../apps/web/src/features/calendar/calendar-utils';
for (const role of ['school_admin', 'teacher', 'student', 'parent', 'principal'] as const)
  test.describe(role, () => {
    test.use({ timetableRole: role });
    test('date-wise subject diary and role-appropriate management', async ({
      page,
      authAppURL,
      platformApp,
    }, info) => {
      const f = platformApp.records,
        today = schoolToday('Asia/Kolkata');
      await platformApp.db.query('DELETE FROM assignments WHERE school_id=$1', [f.schoolA]);
      await platformApp.db.query(
        "INSERT INTO assignments(school_id,class_id,subject_id,kind,title,body,assigned_on,instructions,created_by) VALUES($1,$2,$3,'HOMEWORK','Mathematics diary entry','Exercises 1–5',$4,'Show all steps',$5)",
        [f.schoolA, f.classId, f.subject, today, f.admin],
      );
      const prefix = role === 'school_admin' ? 'admin' : role;
      await page.goto(authAppURL + `/${prefix}/r/assignments`);
      await expect(
        page.getByRole('heading', { name: 'Homework diary', exact: true }),
      ).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Mathematics', exact: true })).toBeVisible();
      await expect(page.getByText('Mathematics diary entry', { exact: true })).toBeVisible();
      await expect(page.getByText('Show all steps', { exact: true })).toBeVisible();
      expect(await page.getByRole('button', { name: 'Add homework', exact: true }).count()).toBe(
        ['school_admin', 'teacher'].includes(role) ? 1 : 0,
      );
      await page.getByRole('button', { name: 'Next date', exact: true }).click();
      await expect(page.getByText('No homework for this date', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Today', exact: true }).click();
      await expect(page.getByText('Mathematics diary entry', { exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      if (role === 'school_admin') {
        await page.getByRole('button', { name: 'Edit', exact: true }).click();
        await page.getByLabel('Title', { exact: true }).fill('Updated diary entry');
        await page.getByRole('button', { name: 'Save record', exact: true }).click();
        await expect(page.getByText('Updated diary entry', { exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'Delete', exact: true }).click();
        await page
          .getByRole('dialog')
          .getByRole('button', { name: 'Delete homework', exact: true })
          .click();
        await expect(page.getByText('No homework for this date', { exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'Add homework', exact: true }).click();
        await page.getByLabel('Class', { exact: true }).selectOption(f.classId);
        await page.getByRole('combobox', { name: /Subject/ }).selectOption(f.subject);
        await page.getByLabel('Title', { exact: true }).fill('Created diary entry');
        await page.getByRole('button', { name: 'Save record', exact: true }).click();
        await expect(page.getByText('Created diary entry', { exact: true })).toBeVisible();
      }
      await page.screenshot({ path: info.outputPath('homework-diary.png'), fullPage: true });
    });
  });
