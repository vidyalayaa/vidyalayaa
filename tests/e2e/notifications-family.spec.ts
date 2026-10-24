import { expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { test } from './fixtures/family-calendar-app';
import { fixtureToken } from './fixtures/platform-app';
test.setTimeout(120000);
for (const role of ['parent', 'student'] as const)
  test.describe(role + ' notifications', () => {
    test.use({ calendarRole: role });
    test('shows only own targeted messages and no management actions', async ({
      page,
      platformApp,
      authAppURL,
    }) => {
      const f = platformApp.records,
        id = role === 'parent' ? f.parent : f.studentUser,
        other = role === 'parent' ? f.studentUser : f.parent;
      for (const [uid, title] of [
        [id, 'A private update for ' + role],
        [other, 'Another member private message for ' + role],
      ]) {
        const r = await fetch(platformApp.url + '/api/v1/notifications/messages', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + fixtureToken(f.admin),
            'X-School-Id': f.schoolA,
            'Content-Type': 'application/json',
            'Idempotency-Key': crypto.randomUUID(),
          },
          body: JSON.stringify({
            title,
            body: 'School message details',
            audience: 'MEMBERS',
            roles: [],
            user_ids: [uid],
          }),
        });
        expect(r.status).toBe(202);
      }
      await page.goto(authAppURL + '/' + role + '/notifications');
      await expect(page.getByRole('heading', { name: 'A private update for ' + role })).toBeVisible(
        { timeout: 30000 },
      );
      await expect(page.locator('main')).not.toContainText(
        'Another member private message for ' + role,
      );
      for (const name of ['Send notification', 'Automatic alerts', 'School history'])
        await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: 'Enable notifications', exact: true }),
      ).toBeVisible();
      const audit = await new AxeBuilder({ page }).include('main').analyze();
      expect(
        audit.violations.filter((v) => ['serious', 'critical'].includes(v.impact || '')),
      ).toEqual([]);
    });
  });
