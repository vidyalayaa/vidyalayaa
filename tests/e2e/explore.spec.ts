import { expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { test } from './fixtures/auth-app';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('vidyalayaa_splash_shown', '1'));
});

test('public theme follows system changes and applies immediately to sign-in and recovery', async ({
  page,
  authAppURL,
}) => {
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.goto(authAppURL + '/explore');
  const root = page.locator('html');
  const selector = page.getByRole('combobox', { name: 'Theme' });
  const logo = page.locator('.explore-brand .brand-symbol').first();
  await expect(selector).toHaveValue('system');
  await expect(root).toHaveAttribute('data-theme', 'dark');
  await expect(root).toHaveCSS('background-color', 'rgb(0, 0, 0)');
  await expect(logo).toHaveCSS('background-color', 'rgb(199, 245, 91)');
  const viewport = page.viewportSize()!;
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: viewport.height });
    const bounds = (await selector.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
  }
  await page.setViewportSize(viewport);
  expect((await new AxeBuilder({ page }).withRules('color-contrast').analyze()).violations).toEqual(
    [],
  );
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(root).toHaveAttribute('data-theme', 'light');
  await expect(logo).toHaveCSS('background-color', 'rgb(199, 245, 91)');
  await selector.focus();
  await expect(selector).toBeFocused();
  await selector.selectOption('dark');
  await expect(root).toHaveAttribute('data-theme', 'dark');

  await page.goto(authAppURL + '/login');
  await expect(selector).toHaveValue('dark');
  await expect(root).toHaveCSS('color-scheme', 'dark');
  await expect(page.locator('.login-page')).toHaveCSS('background-color', 'rgb(0, 0, 0)');
  await expect(page.locator('.login-story')).toHaveCSS('background-color', 'rgb(199, 245, 91)');
  await page.getByRole('button', { name: 'Forgot password?' }).click();
  await expect(page.getByRole('button', { name: 'Send recovery link' })).toBeVisible();
  expect((await new AxeBuilder({ page }).withRules('color-contrast').analyze()).violations).toEqual(
    [],
  );
  await selector.selectOption('light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(root).toHaveAttribute('data-theme', 'light');
});

async function newAccount(page: Page) {
  const user = {
    id: '00000000-0000-4000-8000-000000009501',
    email: 'explore@example.test',
    aud: 'authenticated',
    role: 'authenticated',
    app_metadata: {},
    user_metadata: {},
    created_at: '2026-01-01T00:00:00Z',
    factors: [],
  };
  await page.addInitScript((user) => {
    localStorage.setItem(
      'sb-mfa-qr-auth-token',
      JSON.stringify({
        user,
        access_token: 'test-only-explore-token',
        refresh_token: 'test-only-explore-refresh',
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
  }, user);
  await page.route('https://mfa-qr.test/auth/v1/user', (route) => route.fulfill({ json: user }));
  const schoolRequests: string[] = [];
  await page.route('**/api/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/me')
      return route.fulfill({
        json: {
          ...user,
          full_name: 'New account',
          memberships: [],
          school: null,
          platform_role: null,
          features: {},
          limits: {},
        },
      });
    if (path === '/api/v1/invitations/pending') return route.fulfill({ json: { data: [] } });
    schoolRequests.push(path);
    return route.fulfill({ status: 403, json: { error: { message: 'No school access' } } });
  });
  return schoolRequests;
}

test('public Explore works without sign-in, private API requests, or layout overflow', async ({
  page,
  authAppURL,
}) => {
  const requests: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.url().includes('/api/v1/')) requests.push(request.url());
  });
  await page.goto(authAppURL + '/explore');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('More connected.');
  await expect(page).toHaveTitle('Explore Vidyalayaa | Your school, in sync.');
  await expect(page.getByText('Illustrative preview', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('group', { name: 'Choose a role to explore' }).getByRole('button'),
  ).toHaveCount(5);
  await expect(page.getByRole('button', { name: 'Super Admin' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
  expect(requests).toEqual([]);
  expect(errors).toEqual([]);
  await page
    .getByRole('heading', { name: 'Let’s bring your school together.' })
    .scrollIntoViewIfNeeded();
  await expect(page.getByRole('link', { name: 'Talk to Vidyalayaa' })).toHaveAttribute(
    'href',
    'mailto:vidyalayaainfo@gmail.com?subject=Vidyalayaa%20school%20onboarding',
  );
  await page.screenshot({
    path: `test-results/explore-${test.info().project.name}.png`,
    fullPage: true,
    animations: 'disabled',
    scale: 'css',
  });
});

test('role previews, FAQs, and navigation respond without granting school access', async ({
  page,
  authAppURL,
  isMobile,
}) => {
  await page.goto(authAppURL + '/explore');
  const descriptions = [
    ['School Admin', 'A little less admin. A lot more clarity.'],
    ['Principal', 'See the school beyond the paperwork.'],
    ['Teacher', 'More room for what you do best.'],
    ['Parent', 'Stay close to their school day.'],
    ['Student', 'Your school day, all together.'],
  ];
  for (const [name, description] of descriptions) {
    const button = page.getByRole('button', { name, exact: true });
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('heading', { name: description, exact: true })).toBeVisible();
  }
  await page.locator('summary').filter({ hasText: 'Can I choose my own role?' }).click();
  await expect(
    page.getByText('Your school assigns your role and access.', { exact: false }),
  ).toBeVisible();
  if (isMobile) {
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await page
      .getByRole('navigation', { name: 'Mobile explore navigation' })
      .getByRole('link', { name: 'The platform' })
      .click();
    await expect(page.getByRole('button', { name: 'Open navigation' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  } else
    await page
      .getByRole('navigation', { name: 'Explore navigation' })
      .getByRole('link', { name: 'The platform' })
      .click();
  await expect(page).toHaveURL(/#features$/);
  if (isMobile) await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('banner').getByRole('link', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByRole('link', { name: 'Explore Vidyalayaa', exact: true }).click();
  await expect(page).toHaveURL(/\/explore$/);
});

test('new users see Explore instead of sessions and cannot enter a school through previews', async ({
  page,
  authAppURL,
  isMobile,
}) => {
  const requests = await newAccount(page);
  await page.goto(authAppURL + '/');
  await expect(
    page.getByRole('heading', { name: 'Welcome to Vidyalayaa.', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Security & Login Sessions' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
  await page.getByRole('link', { name: 'Explore Vidyalayaa', exact: true }).click();
  await page.getByRole('button', { name: 'School Admin', exact: true }).click();
  if (isMobile) await page.getByRole('button', { name: 'Open navigation' }).click();
  await page
    .getByRole('banner')
    .getByRole('link', { name: 'Back to workspace', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Welcome to Vidyalayaa.', exact: true }),
  ).toBeVisible();
  await page.goto(authAppURL + '/admin/r/students');
  await expect(
    page.getByRole('heading', { name: 'Welcome to Vidyalayaa.', exact: true }),
  ).toBeVisible();
  expect(requests).toEqual([]);
});

test('new users can sign out through the authentication provider', async ({ page, authAppURL }) => {
  await newAccount(page);
  let loggedOut = 0;
  await page.route('https://mfa-qr.test/auth/v1/logout**', (route) => {
    loggedOut++;
    return route.fulfill({ status: 204 });
  });
  await page.goto(authAppURL + '/');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(/\/login/);
  expect(loggedOut).toBe(1);
  expect(await page.evaluate(() => localStorage.getItem('sb-mfa-qr-auth-token'))).toBeNull();
});

test('public Explore remains usable if a signed-in account lookup is unavailable', async ({
  page,
  authAppURL,
}) => {
  await newAccount(page);
  await page.route('**/api/v1/me', (route) =>
    route.fulfill({ status: 503, json: { error: { message: 'Temporary outage' } } }),
  );
  await page.goto(authAppURL + '/explore');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('More connected.');
  await page.getByRole('button', { name: 'Parent', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Stay close to their school day.' }),
  ).toBeVisible();
});
