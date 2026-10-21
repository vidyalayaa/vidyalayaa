import { test as base, fixtureToken } from './platform-app';

// Reuses the disposable SQL/API service, but the browser has only a Principal
// membership. No platform token, configured provider or real project is used.
export const test = base.extend({
  isolateServices: [
    async ({ page, platformApp }, use) => {
      const user = {
        id: platformApp.records.principal,
        email: `${platformApp.records.principal}@example.invalid`,
        aud: 'authenticated',
        role: 'authenticated',
        factors: [],
        app_metadata: {},
        user_metadata: {},
        created_at: '2026-01-01T00:00:00Z',
      };
      await page.addInitScript(
        ({ user, token, school }) => {
          sessionStorage.setItem('vidyalayaa.school', school);
          sessionStorage.setItem('vidyalayaa.identity', user.id);
          localStorage.setItem(
            'sb-mfa-qr-auth-token',
            JSON.stringify({
              user,
              access_token: token,
              refresh_token: 'isolated-principal-refresh',
              token_type: 'bearer',
              expires_in: 3600,
              expires_at: Math.floor(Date.now() / 1000) + 3600,
            }),
          );
        },
        { user, token: fixtureToken(user.id), school: platformApp.records.schoolA },
      );
      await page.route('https://mfa-qr.test/auth/v1/user', (route) =>
        route.fulfill({ json: user }),
      );
      await page.route('https://mfa-qr.test/auth/v1/logout**', (route) =>
        route.fulfill({ status: 204 }),
      );
      await page.route('**/api/v1/**', async (route) => {
        const url = new URL(route.request().url());
        const response = await route.fetch({ url: platformApp.url + url.pathname + url.search });
        await route.fulfill({ response });
      });
      const failures: string[] = [];
      page.on('pageerror', (error) => failures.push(error.message));
      await use();
      if (failures.length) throw new Error('Browser errors: ' + failures.join('; '));
    },
    { auto: true },
  ],
});
