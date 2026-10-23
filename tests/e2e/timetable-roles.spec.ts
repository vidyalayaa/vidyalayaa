import { expect } from '@playwright/test';
import { test } from './fixtures/timetable-role-app';
import { saveTimingTemplate, timetableAdmin, timetableSection } from './fixtures/timetable-data';
test.setTimeout(120000);
for (const role of ['teacher', 'student', 'principal'] as const)
  test.describe(role + ' weekly timetable', () => {
    test.use({ timetableRole: role });
    test('shows authorized classes and teacher/subject details with no timetable management access', async ({
      page,
      authAppURL,
      platformApp,
    }) => {
      const f = platformApp.records,
        call = timetableAdmin(platformApp);
      await saveTimingTemplate(platformApp);
      const other = await timetableSection(platformApp, role.toUpperCase());
      if (!(await call('/timetable/classes/' + f.classId + '/entries')).body.total)
        expect(
          (
            await call('/resources/timetable_entries', 'POST', {
              class_id: f.classId,
              subject_id: f.subject,
              teacher_id: f.teacherId,
              weekday: 1,
              starts_at: '08:00',
              ends_at: '08:45',
              room: 'Shared classroom',
            })
          ).status,
        ).toBe(201);
      await page.goto(authAppURL + '/' + role + '/r/timetable_entries');
      await page
        .getByRole('combobox', { name: 'Class and section', exact: true })
        .selectOption(f.classId);
      await expect(
        page.getByRole('article', { name: 'Monday Lecture 1: Mathematics', exact: true }),
      ).toContainText('Teacher Test');
      for (const action of ['School timings', 'Add lecture', 'Edit lecture', 'Delete lecture'])
        await expect(page.getByRole('button', { name: new RegExp('^' + action) })).toHaveCount(0);
      const options = await page
        .locator('#timetable-class option')
        .evaluateAll((nodes) => nodes.map((n) => (n as HTMLOptionElement).value));
      if (role === 'principal') expect(options).toContain(other.classId);
      else expect(options).not.toContain(other.classId);
      const identity =
        role === 'student' ? f.studentUser : role === 'teacher' ? f.teacher : f.principal;
      expect(
        (
          await platformApp.request(
            '/timetable/settings',
            'PUT',
            { expected_version: 1, settings: {} },
            identity,
            f.schoolA,
          )
        ).status,
      ).toBe(403);
      expect(
        (await platformApp.request('/resources/timetable_entries', 'POST', {}, identity, f.schoolA))
          .status,
      ).toBe(403);
      if (role !== 'principal')
        expect(
          (
            await platformApp.request(
              '/timetable/classes/' + other.classId + '/entries',
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
