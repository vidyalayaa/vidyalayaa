import { expect } from '@playwright/test';
import { test } from './fixtures/timetable-role-app';
import { fixtureToken } from './fixtures/platform-app';
test.setTimeout(120000);
for (const role of ['teacher', 'principal'] as const)
  test.describe(role + ' notifications', () => {
    test.use({ timetableRole: role });
    test('receives selected staff messages with appropriate read-only school history access', async ({
      page,
      platformApp,
      authAppURL,
    }) => {
      const f = platformApp.records,
        id = role === 'teacher' ? f.teacher : f.principal;
      const r = await fetch(platformApp.url + '/api/v1/notifications/messages', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + fixtureToken(f.admin),
          'X-School-Id': f.schoolA,
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          title: 'Staff update for ' + role,
          body: 'Meeting details',
          audience: 'MEMBERS',
          roles: [],
          user_ids: [id],
        }),
      });
      expect(r.status).toBe(202);
      await page.goto(authAppURL + '/' + role + '/notifications');
      await expect(page.getByRole('heading', { name: 'Staff update for ' + role })).toBeVisible({
        timeout: 30000,
      });
      await expect(
        page.getByRole('button', { name: 'Send notification', exact: true }),
      ).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Automatic alerts', exact: true })).toHaveCount(
        0,
      );
      await expect(page.getByRole('button', { name: 'School history', exact: true })).toHaveCount(
        role === 'principal' ? 1 : 0,
      );
      if (role === 'principal') {
        await page.getByRole('button', { name: 'School history', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Staff update for ' + role })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Cancel queued' })).toHaveCount(0);
      }
    });
  });
