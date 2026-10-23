import { test as base, fixtureToken } from './platform-app';
export const test = base.extend<{
  sessionRole:
    | 'super_admin'
    | 'school_admin'
    | 'principal'
    | 'teacher'
    | 'parent'
    | 'student'
    | 'unassigned';
  accountClient: {
    id: string;
    token: string;
    current: string;
    remote: string;
    remoteToken: string;
    second: string;
  };
}>({
  sessionRole: ['school_admin', { option: true }],
  accountClient: [
    async ({ page, platformApp, sessionRole }, use) => {
      const f = platformApp.records;
      const id = {
        super_admin: platformApp.root,
        school_admin: f.admin,
        principal: f.principal,
        teacher: f.teacher,
        parent: f.parent,
        student: f.studentUser,
        unassigned: crypto.randomUUID(),
      }[sessionRole];
      if (sessionRole === 'unassigned') {
        await platformApp.db.query(
          'INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,$2,now())',
          [id, id + '@example.invalid'],
        );
        platformApp.registerIdentity(id);
      }
      const current = crypto.randomUUID(),
        remote = crypto.randomUUID(),
        second = crypto.randomUUID();
      const token = fixtureToken(id, 'aal2', current),
        remoteToken = fixtureToken(id, 'aal2', remote);
      for (const sid of [remote, second]) {
        await platformApp.db.query(
          "INSERT INTO auth.sessions(id,user_id,user_agent,ip) VALUES($1,$2,'Mozilla/5.0 (iPhone) Version/17.0 Mobile Safari/605.1','192.0.2.55')",
          [sid, id],
        );
      }
      // Mark the provider fixture’s issued tokens before testing retained-token rejection.
      await fetch(platformApp.url + '/api/v1/me', {
        headers: { Authorization: 'Bearer ' + remoteToken },
      });
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
          sessionStorage.setItem('vidyalayaa.identity', user.id);
          if (school) sessionStorage.setItem('vidyalayaa.school', school);
          localStorage.setItem(
            'sb-mfa-qr-auth-token',
            JSON.stringify({
              user,
              access_token: token,
              refresh_token: 'isolated-session-refresh',
              token_type: 'bearer',
              expires_in: 3600,
              expires_at: Math.floor(Date.now() / 1000) + 3600,
            }),
          );
        },
        {
          user,
          token,
          school: ['super_admin', 'unassigned'].includes(sessionRole) ? '' : f.schoolA,
        },
      );
      await page.route('https://mfa-qr.test/auth/v1/user', (r) => r.fulfill({ json: user }));
      await page.route('https://mfa-qr.test/auth/v1/logout**', (r) => r.fulfill({ status: 204 }));
      await page.route('**/api/v1/**', async (route) => {
        const url = new URL(route.request().url());
        const response = await route.fetch({ url: platformApp.url + url.pathname + url.search });
        await route.fulfill({ response });
      });
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await use({ id, token, current, remote, remoteToken, second });
      if (errors.length) throw new Error('Session browser errors: ' + errors.join('; '));
    },
    { auto: true },
  ],
});
