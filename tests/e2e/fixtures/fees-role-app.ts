import { test as base, fixtureToken } from './platform-app';
export const test = base.extend<{ feeRole: 'parent' | 'student' | 'principal' | 'finance_staff' }>({
  feeRole: ['parent', { option: true }],
  isolateServices: [
    async ({ page, platformApp, feeRole }, use) => {
      const f = platformApp.records;
      let id =
        feeRole === 'parent' ? f.parent : feeRole === 'student' ? f.studentUser : f.principal;
      if (feeRole === 'finance_staff') {
        id = crypto.randomUUID();
        platformApp.registerIdentity(id);
        await platformApp.db.query(
          'INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3)',
          [id, id + '@example.invalid', { full_name: 'Browser finance' }],
        );
        await platformApp.db.query(
          "INSERT INTO school_memberships(school_id,user_id,role_id) SELECT $1,$2,id FROM roles WHERE code='finance_staff'",
          [f.schoolA, id],
        );
        await platformApp.db.query(
          "INSERT INTO teachers(school_id,user_id,staff_code,full_name,staff_role) VALUES($1,$2,$3,'Browser finance','finance_staff')",
          [f.schoolA, id, 'FIN-' + id],
        );
      }
      const user = {
        id,
        email: id + '@example.invalid',
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
              refresh_token: 'isolated-fee-refresh',
              token_type: 'bearer',
              expires_in: 3600,
              expires_at: Math.floor(Date.now() / 1000) + 3600,
            }),
          );
        },
        { user, token: fixtureToken(id), school: f.schoolA },
      );
      await page.route('https://mfa-qr.test/auth/v1/user', (route) =>
        route.fulfill({ json: user }),
      );
      await page.route('https://mfa-qr.test/auth/v1/logout**', (route) =>
        route.fulfill({ status: 204 }),
      );
      await page.route('**/api/v1/**', async (route) => {
        const url = new URL(route.request().url()),
          response = await route.fetch({ url: platformApp.url + url.pathname + url.search });
        await route.fulfill({ response });
      });
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await use();
      if (errors.length) throw new Error('Fee role browser errors: ' + errors.join('; '));
    },
    { auto: true },
  ],
});
