import { test as base, fixtureToken } from './platform-app';
export const test = base.extend<{
  timetableRole: 'teacher' | 'student' | 'principal' | 'parent' | 'school_admin' | 'super_admin';
}>({
  timetableRole: ['teacher', { option: true }],
  isolateServices: [
    async ({ page, platformApp, timetableRole }, use) => {
      const f = platformApp.records,
        user = {
          id:
            timetableRole === 'student'
              ? f.studentUser
              : timetableRole === 'teacher'
                ? f.teacher
                : timetableRole === 'parent'
                  ? f.parent
                  : timetableRole === 'school_admin'
                    ? f.admin
                    : timetableRole === 'super_admin'
                      ? platformApp.root
                      : f.principal,
          email: timetableRole + '@example.invalid',
          aud: 'authenticated',
          role: 'authenticated',
          factors: [],
          app_metadata: {},
          user_metadata: {},
          created_at: '2026-01-01T00:00:00Z',
        };
      if (timetableRole === 'super_admin')
        await platformApp.db.query(
          "INSERT INTO school_memberships(school_id,user_id,role_id,status) SELECT $1,$2,id,'ACTIVE' FROM roles WHERE code='school_admin' ON CONFLICT(school_id,user_id) DO NOTHING",
          [f.schoolA, platformApp.root],
        );
      await page.addInitScript(
        ({ user, token, school }) => {
          sessionStorage.setItem('vidyalayaa.school', school);
          sessionStorage.setItem('vidyalayaa.identity', user.id);
          localStorage.setItem(
            'sb-mfa-qr-auth-token',
            JSON.stringify({
              user,
              access_token: token,
              refresh_token: 'isolated-timetable-refresh',
              token_type: 'bearer',
              expires_in: 3600,
              expires_at: Math.floor(Date.now() / 1000) + 3600,
            }),
          );
        },
        { user, token: fixtureToken(user.id), school: f.schoolA },
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
      if (errors.length) throw new Error('Timetable browser errors: ' + errors.join('; '));
    },
    { auto: true },
  ],
});
