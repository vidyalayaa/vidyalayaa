import { expect } from '@playwright/test';
import { fixtureToken, test } from './fixtures/platform-app';

// Each role opens a new context. Keep screenshots without merging several large traces.
test.use({ trace: 'off' });

for (const mode of ['light', 'dark', 'system', null] as const) {
  const supportOnly = mode === null;
  const resolvedTheme = mode === 'light' ? 'light' : 'dark';
  test(
    supportOnly
      ? 'support contact works across all workspace roles'
      : `public pages and each role’s navigation render in ${mode} mode`,
    async ({ browser, authAppURL, platformApp, isMobile }, info) => {
      test.setTimeout(240_000);
      const { viewport, deviceScaleFactor, hasTouch, userAgent } = info.project.use;
      const options = {
        viewport,
        deviceScaleFactor,
        hasTouch,
        userAgent,
        isMobile,
        colorScheme: mode === 'dark' ? ('light' as const) : ('dark' as const),
        reducedMotion: 'reduce' as const,
      };
      const failures: string[] = [];
      let checked = 0;

      if (!supportOnly) {
        const publicContext = await browser.newContext(options);
        await publicContext.addInitScript((mode) => {
          localStorage.setItem('vidyalayaa.theme.guest', mode);
          sessionStorage.setItem('vidyalayaa_splash_shown', '1');
        }, mode);
        try {
          const page = await publicContext.newPage();
          page.on('pageerror', (error) => failures.push(`${page.url()}: ${error.message}`));
          for (const path of ['/explore', '/login']) {
            await page.goto(authAppURL + path);
            await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({
              timeout: 15_000,
            });
            await expect(page.locator('html')).toHaveAttribute('data-theme', resolvedTheme);
            await expect(
              page.getByText('Unexpected Application Error!', { exact: true }),
            ).toHaveCount(0);
            checked++;
          }
        } finally {
          await publicContext.close();
        }
      }

      const f = platformApp.records;
      const finance = crypto.randomUUID();
      platformApp.registerIdentity(finance);
      await platformApp.db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [
        finance,
        `${finance}@example.invalid`,
      ]);
      await platformApp.db.query(
        "INSERT INTO school_memberships(school_id,user_id,role_id) SELECT $1,$2,id FROM roles WHERE code='finance_staff'",
        [f.schoolA, finance],
      );
      await platformApp.db.query(
        "INSERT INTO teachers(school_id,user_id,staff_code,full_name,staff_role) VALUES($1,$2,$3,'Browser finance','finance_staff')",
        [f.schoolA, finance, `FIN-${finance}`],
      );
      for (const [portal, id] of [
        ['platform', platformApp.root],
        ['admin', f.admin],
        ['principal', f.principal],
        ['teacher', f.teacher],
        ['parent', f.parent],
        ['student', f.studentUser],
        ['finance', finance],
      ]) {
        await test.step(portal, async () => {
          const context = await browser.newContext(options);
          try {
            const user = {
              id,
              email: `${id}@example.invalid`,
              aud: 'authenticated',
              role: 'authenticated',
              factors: [],
              app_metadata: {},
              user_metadata: mode ? { vidyalayaa_theme: mode } : {},
              created_at: '2026-01-01T00:00:00Z',
            };
            await context.addInitScript(
              ({ session, school }) => {
                localStorage.setItem('sb-mfa-qr-auth-token', JSON.stringify(session));
                sessionStorage.setItem('vidyalayaa.identity', session.user.id);
                if (school) sessionStorage.setItem('vidyalayaa.school', school);
              },
              {
                school: portal === 'platform' ? undefined : f.schoolA,
                session: {
                  user,
                  access_token: fixtureToken(id),
                  refresh_token: 'isolated-navigation-refresh',
                  token_type: 'bearer',
                  expires_in: 3600,
                  expires_at: Math.floor(Date.now() / 1000) + 3600,
                },
              },
            );
            await context.route('https://mfa-qr.test/auth/v1/user', (route) =>
              route.fulfill({ json: user }),
            );
            await context.route('**/api/v1/**', async (route) => {
              const url = new URL(route.request().url());
              await route.fulfill({
                response: await route.fetch({ url: platformApp.url + url.pathname + url.search }),
              });
            });
            const page = await context.newPage();
            page.on('pageerror', (error) => failures.push(`${page.url()}: ${error.message}`));
            await page.goto(`${authAppURL}/${portal}`);
            const main = page.getByRole('main');
            await expect(main.getByRole('heading', { level: 1 }).first()).toBeVisible({
              timeout: 15_000,
            });
            if (mode) {
              await expect(page.locator('html')).toHaveAttribute('data-theme', resolvedTheme);
              await expect(page.locator('html')).toHaveCSS('color-scheme', resolvedTheme);
              await expect(page.locator('.topbar').getByLabel('Theme')).toHaveValue(mode);
            }
            checked++;
            const sidebar = page.locator('aside.sidebar');
            if (supportOnly) {
              const supportEmail = 'vidyalayaainfo@gmail.com';
              if (isMobile && portal === 'teacher') {
                await expect
                  .poll(() =>
                    page.evaluate(
                      () =>
                        document.documentElement.scrollWidth <=
                        document.documentElement.clientWidth + 1,
                    ),
                  )
                  .toBe(true);
              }
              if (isMobile) await page.getByRole('button', { name: 'Open navigation' }).click();
              const trigger = sidebar.getByRole('button', { name: 'Let’s talk', exact: true });
              await trigger.click({ timeout: 10_000 });
              const dialog = page.getByRole('dialog', { name: 'Contact Vidyalayaa support' });
              const email = dialog.getByRole('textbox', { name: 'Support email' });
              const compose = dialog.getByRole('link', { name: 'Open Gmail draft' });
              await expect(email).toHaveValue(supportEmail);
              const draft = new URL((await compose.getAttribute('href'))!);
              expect(draft.origin).toBe('https://mail.google.com');
              expect(draft.searchParams.get('to')).toBe(supportEmail);
              await expect(compose).toHaveAttribute('target', '_blank');
              const requests = dialog.getByRole('link', { name: 'Support requests', exact: true });
              if (portal === 'admin')
                await expect(requests).toHaveAttribute('href', '/admin/support');
              else await expect(requests).toHaveCount(0);

              const rejectCopy = portal === 'student';
              await page.evaluate((reject) => {
                Object.defineProperty(navigator, 'clipboard', {
                  configurable: true,
                  value: {
                    writeText: async (value: string) => {
                      if (reject) throw new Error('Clipboard permission denied');
                      sessionStorage.setItem('support-copy-test', value);
                    },
                  },
                });
              }, rejectCopy);
              await dialog.getByRole('button', { name: 'Copy email' }).click({ timeout: 10_000 });
              if (rejectCopy) {
                await expect(dialog.getByRole('status')).toContainText('Support email selected.');
                await expect(email).toBeFocused();
                expect(await email.evaluate((input: HTMLInputElement) => input.selectionEnd)).toBe(
                  supportEmail.length,
                );
              } else {
                await expect(dialog.getByRole('status')).toHaveText('Support email copied.');
                expect(await page.evaluate(() => sessionStorage.getItem('support-copy-test'))).toBe(
                  supportEmail,
                );
              }

              if (portal === 'platform') {
                await context.route('https://mail.google.com/mail/**', (route) =>
                  route.fulfill({ body: 'Gmail navigation test' }),
                );
                const popup = context.waitForEvent('page', { timeout: 10_000 });
                await compose.click({ timeout: 10_000 });
                const draftPage = await popup;
                await draftPage.waitForURL(draft.href);
                await draftPage.close();
              }
              await page.keyboard.press('Escape');
              await expect(dialog).toHaveCount(0);
              await expect(trigger).toBeFocused();
              return;
            }
            const links = await sidebar
              .locator(
                'nav a[href^="/"], .sidebar-bottom a[href$="/settings"], .sidebar-bottom a[href="/settings"]',
              )
              .evaluateAll((nodes) =>
                nodes.map((node) => ({
                  href: node.getAttribute('href')!,
                  schoolAction: !!node.closest('.school-actions'),
                })),
              );
            expect(links.length, `${portal} navigation links`).toBeGreaterThan(3);
            for (const { href, schoolAction } of links) {
              if (new URL(page.url()).pathname === href) continue;
              try {
                if (
                  isMobile &&
                  !(await sidebar.evaluate((element) => element.classList.contains('sidebar-open')))
                )
                  await page.getByRole('button', { name: 'Open navigation' }).click();
                if (schoolAction) await sidebar.locator('summary.school-selector').click();
                await sidebar.locator(`a[href="${href}"]`).first().click({ timeout: 5000 });
                await expect(page).toHaveURL(authAppURL + href, { timeout: 10_000 });
                await expect(main.getByRole('heading', { level: 1 }).first()).toBeVisible({
                  timeout: 10_000,
                });
                await expect(page.locator('html')).toHaveAttribute('data-theme', resolvedTheme);
                await expect(
                  main.getByRole('heading', {
                    name: /Access unavailable|This area belongs to another role|Page not found|We couldn’t complete that request/,
                  }),
                ).toHaveCount(0);
                checked++;
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                failures.push(`${href}: ${message.split('\n').slice(0, 8).join('\n')}`);
                await page.goto(`${authAppURL}/${portal}`);
                await expect(main.getByRole('heading', { level: 1 }).first()).toBeVisible({
                  timeout: 15_000,
                });
              }
            }
          } finally {
            await context.close();
          }
        });
      }
      console.log(
        `${info.project.name}: ${checked} page visits passed across public pages and role workspaces.`,
      );
      expect(failures).toEqual([]);
    },
  );
}
