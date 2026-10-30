import { test as base, fixtureToken } from './platform-app';

// Reuses the disposable SQL/API service, but the browser has only a School Admin
// membership. No platform token, configured provider or real project is used.
export const test = base.extend<{ implicitSchool: boolean }>({
  implicitSchool: [false, { option: true }],
  isolateServices: [
    async ({ page, platformApp, implicitSchool }, use) => {
      // The shared administrator also owns a closure-test school. Use a separate
      // identity to exercise the real server's single-membership default.
      const browserAdmin = implicitSchool ? crypto.randomUUID() : platformApp.records.admin;
      if (implicitSchool) {
        await platformApp.db.query(
          'INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3)',
          [
            browserAdmin,
            `${browserAdmin}@example.invalid`,
            { full_name: 'Single school administrator' },
          ],
        );
        await platformApp.db.query(
          "INSERT INTO school_memberships(school_id,user_id,role_id,status) SELECT $1,$2,id,'ACTIVE' FROM roles WHERE code='school_admin'",
          [platformApp.records.schoolA, browserAdmin],
        );
        platformApp.registerIdentity(browserAdmin);
      }
      const user = {
        id: browserAdmin,
        email: `${browserAdmin}@example.invalid`,
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
              refresh_token: 'isolated-school-refresh',
              token_type: 'bearer',
              expires_in: 3600,
              expires_at: Math.floor(Date.now() / 1000) + 3600,
            }),
          );
        },
        {
          user,
          token: fixtureToken(user.id),
          school: implicitSchool ? '' : platformApp.records.schoolA,
        },
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
