import { expect } from '@playwright/test';
import { fixtureToken, test } from './fixtures/platform-app';

// Each role opens a new context. Keep screenshots without merging several large traces.
test.use({ trace: 'off' });

test('public pages and each role’s navigation render without application errors', async ({
  browser,
  authAppURL,
  platformApp,
  isMobile,
}, info) => {
  test.setTimeout(240_000);
  const { viewport, deviceScaleFactor, hasTouch, userAgent } = info.project.use;
  const options = { viewport, deviceScaleFactor, hasTouch, userAgent, isMobile };
  const failures: string[] = [];
  let checked = 0;

  const publicContext = await browser.newContext(options);
  try {
    const page = await publicContext.newPage();
    page.on('pageerror', (error) => failures.push(`${page.url()}: ${error.message}`));
    for (const path of ['/explore', '/login']) {
      await page.goto(authAppURL + path);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      await expect(page.getByText('Unexpected Application Error!', { exact: true })).toHaveCount(0);
      checked++;
    }
  } finally {
    await publicContext.close();
  }

  const f = platformApp.records;
  for (const [portal, id] of [
    ['platform', platformApp.root],
    ['admin', f.admin],
    ['principal', f.principal],
    ['teacher', f.teacher],
    ['parent', f.parent],
    ['student', f.studentUser],
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
          user_metadata: {},
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
        checked++;
        const sidebar = page.locator('aside.sidebar');
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
});
