import { expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { test } from './fixtures/sessions-app';
import { fixtureToken } from './fixtures/platform-app';

test('refreshes an expired access token when its provider session remains valid', async ({
  page,
  authAppURL,
  accountClient,
}) => {
  let refreshes = 0,
    requests = 0;
  await page.route('https://mfa-qr.test/auth/v1/token**', (route) => {
    refreshes++;
    return route.fulfill({
      json: {
        access_token: fixtureToken(accountClient.id, 'aal2', accountClient.current),
        refresh_token: 'rotated-test-refresh',
        token_type: 'bearer',
        expires_in: 3600,
        user: {
          id: accountClient.id,
          email: accountClient.id + '@example.invalid',
          aud: 'authenticated',
          role: 'authenticated',
          factors: [],
          app_metadata: {},
          user_metadata: {},
          created_at: '2026-01-01T00:00:00Z',
        },
      },
    });
  });
  await page.route('**/api/v1/account/sessions', (route) => {
    requests++;
    return requests === 1
      ? route.fulfill({
          status: 401,
          json: { error: { code: 'UNAUTHENTICATED', message: 'Access token expired' } },
        })
      : route.fallback();
  });
  await page.goto(authAppURL + '/settings/security');
  await expect(page.getByText('Current Session', { exact: true })).toBeVisible();
  expect(refreshes).toBe(1);
  expect(requests).toBeGreaterThanOrEqual(2);
  await expect(page).not.toHaveURL(/\/login/);
});

test.describe('unassigned account', () => {
  test.use({ sessionRole: 'unassigned' });
  test('preserves school selection while allowing only owned account security', async ({
    page,
    authAppURL,
  }) => {
    await page.goto(authAppURL + '/settings');
    await expect(
      page.getByRole('heading', { name: 'Welcome to Vidyalayaa.', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Explore Vidyalayaa', exact: true })).toBeVisible();
    // Account security remains available by its explicit route, without becoming
    // the landing experience for people who have not joined a school.
    await page.goto(authAppURL + '/settings/security');
    await expect(
      page.getByRole('heading', { name: 'Security & Login Sessions', exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Current Session', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Log out all other devices', exact: true }).click();
    await page
      .getByRole('button', { name: 'Confirm logout of other devices', exact: true })
      .click();
    await expect(page.getByRole('article')).toHaveCount(1);
    await expect(page.getByRole('link', { name: 'Students', exact: true })).toHaveCount(0);
  });
});

for (const role of [
  'super_admin',
  'school_admin',
  'principal',
  'teacher',
  'parent',
  'student',
] as const)
  test.describe(role, () => {
    test.use({ sessionRole: role });
    test('manages only owned sessions and keeps the current device active', async ({
      page,
      authAppURL,
      platformApp,
      accountClient,
    }, info) => {
      await page.goto(authAppURL + '/settings');
      await page.getByRole('link', { name: 'Security & Login Sessions' }).click();
      await expect(
        page.getByRole('heading', { name: 'Security & Login Sessions', exact: true }),
      ).toBeVisible();
      await expect(page.getByText('Current Session', { exact: true })).toHaveCount(1);
      const remote = page.getByRole('article').filter({ hasText: '192.0.2.55' });
      await expect(remote).toHaveCount(2);
      await remote.first().getByRole('button', { name: 'End session', exact: true }).click();
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(remote).toHaveCount(2);
      await remote.first().getByRole('button', { name: 'End session', exact: true }).click();
      await page.getByRole('button', { name: 'Confirm logout', exact: true }).click();
      await expect(remote).toHaveCount(1);
      await page.getByRole('button', { name: 'Log out all other devices', exact: true }).click();
      await page
        .getByRole('button', { name: 'Confirm logout of other devices', exact: true })
        .click();
      await expect(page.getByRole('article')).toHaveCount(1);
      await expect(page.getByText('Current Session', { exact: true })).toBeVisible();
      const retained = await fetch(platformApp.url + '/api/v1/me', {
        headers: { Authorization: 'Bearer ' + accountClient.remoteToken },
      });
      expect(retained.status).toBe(401);
      expect(
        (
          await platformApp.db.query('SELECT id FROM auth.sessions WHERE id=$1', [
            accountClient.current,
          ])
        ).rows,
      ).toHaveLength(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      const axe = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze();
      expect(
        axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact || '')),
      ).toEqual([]);
      if (role === 'school_admin')
        await page.screenshot({
          path: `tmp/qa/login-sessions-${info.project.name}.png`,
          fullPage: true,
        });
    });
  });

test('logs out the current browser and leaves other sessions available', async ({
  page,
  authAppURL,
  platformApp,
  accountClient,
}) => {
  await page.goto(authAppURL + '/settings/security');
  await page.getByRole('button', { name: 'Log out this device', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm logout', exact: true }).click();
  await expect(page).toHaveURL(/\/login/);
  expect(
    (
      await platformApp.db.query('SELECT id FROM auth.sessions WHERE id=$1', [
        accountClient.current,
      ])
    ).rows,
  ).toHaveLength(0);
  expect(
    (await platformApp.db.query('SELECT id FROM auth.sessions WHERE id=$1', [accountClient.remote]))
      .rows,
  ).toHaveLength(1);
});

test('clears revoked credentials and returns to sign-in without refreshing a revoked session', async ({
  page,
  authAppURL,
  platformApp,
  accountClient,
}) => {
  await page.goto(authAppURL + '/settings/security');
  await expect(page.getByText('Current Session', { exact: true })).toBeVisible();
  await platformApp.db.query('DELETE FROM auth.sessions WHERE id=$1', [accountClient.current]);
  let refreshes = 0;
  await page.route('https://mfa-qr.test/auth/v1/token**', (route) => {
    refreshes++;
    return route.fulfill({ status: 401, json: { message: 'Revoked' } });
  });
  await page.getByRole('button', { name: 'Refresh sessions', exact: true }).click();
  await expect(page).toHaveURL(/\/login/);
  expect(refreshes).toBe(0);
  expect(await page.evaluate(() => localStorage.getItem('sb-mfa-qr-auth-token'))).toBeNull();
});
