import { expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { test } from './fixtures/family-calendar-app';
import { schoolToday, shiftDate } from '../../apps/web/src/features/calendar/calendar-utils';
test.setTimeout(120000);
for (const role of ['parent', 'student'] as const)
  test.describe(role + ' school calendar', () => {
    test.use({ calendarRole: role });
    test('shows applicable dashboard/calendar events only, stays read-only and immediately respects lost access', async ({
      page,
      authAppURL,
      platformApp,
    }) => {
      const f = platformApp.records,
        identity = role === 'parent' ? f.parent : f.studentUser,
        start = shiftDate(schoolToday(), 1),
        end = shiftDate(start, 2);
      const other = await platformApp.request(
        '/resources/classes',
        'POST',
        {
          academic_session_id: f.session,
          grade: '10',
          section: 'FAMILY_CAL_' + role,
          class_teacher_id: f.teacherId,
        },
        f.admin,
        f.schoolA,
      );
      expect(other.status).toBe(201);
      const created: Record<string, string> = {};
      for (const [title, ids] of [
        [role + ' school-wide holiday', []],
        [role + ' own class activity', [f.classId]],
        [role + ' other class private activity', [other.body.id]],
      ] as const) {
        const r = await platformApp.request(
          '/calendar/events',
          'POST',
          {
            title,
            description: 'Relevant calendar details',
            kind: ids.length ? 'ACTIVITY' : 'HOLIDAY',
            start_date: start,
            end_date: end,
            audience: ids.length ? 'CLASSES' : 'SCHOOL',
            class_ids: ids,
          },
          f.admin,
          f.schoolA,
        );
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        created[title] = r.body.id;
      }
      await page.goto(authAppURL + '/' + role);
      const upcoming = page.getByRole('region', { name: 'Upcoming school events', exact: true });
      await expect(upcoming).toContainText(role + ' school-wide holiday', { timeout: 30000 });
      await expect(upcoming).toContainText(role + ' own class activity');
      await expect(upcoming).not.toContainText(role + ' other class private activity');
      await upcoming.getByRole('link', { name: new RegExp(role + ' own class activity') }).click();
      await expect(page).toHaveURL(new RegExp('/' + role + '/calendar\\?date=' + start));
      await expect(page.getByRole('dialog')).toContainText(role + ' own class activity');
      await expect(page.getByRole('dialog')).not.toContainText(
        role + ' other class private activity',
      );
      for (const action of ['Add event', 'Add event on this date', 'Edit event', 'Delete event'])
        await expect(page.getByRole('button', { name: new RegExp('^' + action) })).toHaveCount(0);
      const axe = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
      expect(
        axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact || '')),
      ).toEqual([]);
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Close dialog', exact: true })
        .click();
      await page
        .getByRole('combobox', { name: 'Class', exact: true })
        .selectOption({ label: 'Class 8 · Test year' });
      expect(
        await page
          .getByRole('combobox', { name: 'Section', exact: true })
          .locator('option')
          .allTextContents(),
      ).not.toContain('Section FAMILY_CAL_' + role);
      expect(
        (
          await platformApp.request(
            '/calendar/events/' + created[role + ' other class private activity'],
            'GET',
            undefined,
            identity,
            f.schoolA,
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await platformApp.request(
            '/calendar/events',
            'POST',
            { title: 'Forbidden' },
            identity,
            f.schoolA,
          )
        ).status,
      ).toBe(403);
      if (role === 'parent') {
        const links = await platformApp.request(
          '/resources/student_parents?student_id=' + f.student,
          'GET',
          undefined,
          f.admin,
          f.schoolA,
        );
        expect(
          (
            await platformApp.request(
              '/resources/student_parents/' + links.body.data[0].id,
              'PATCH',
              { status: 'REVOKED' },
              f.admin,
              f.schoolA,
            )
          ).status,
        ).toBe(200);
      } else {
        const enrollments = await platformApp.request(
          '/resources/enrollments?student_id=' + f.student,
          'GET',
          undefined,
          f.admin,
          f.schoolA,
        );
        expect(
          (
            await platformApp.request(
              '/resources/enrollments/' +
                enrollments.body.data.find((e: any) => e.status === 'ACTIVE').id,
              'PATCH',
              { status: 'ENDED' },
              f.admin,
              f.schoolA,
            )
          ).status,
        ).toBe(200);
      }
      await page.goto(authAppURL + '/' + role + '/calendar?date=' + start);
      if (role === 'parent') {
        await expect(
          page.getByRole('heading', { name: 'No children linked yet', exact: true }),
        ).toBeVisible();
        await expect(page.getByRole('dialog')).toHaveCount(0);
      } else {
        await expect(page.getByRole('dialog')).toContainText(role + ' school-wide holiday');
        await expect(page.getByRole('dialog')).not.toContainText(role + ' own class activity');
      }
      expect(
        (
          await platformApp.request(
            '/calendar/events/' + created[role + ' own class activity'],
            'GET',
            undefined,
            identity,
            f.schoolA,
          )
        ).status,
      ).toBe(404);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    });
  });
