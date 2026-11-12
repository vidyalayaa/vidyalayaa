import { expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { test } from './fixtures/auth-app';

async function accountFixture(
  page: Page,
  options: {
    password?: boolean;
    role?: string;
    signedIn?: boolean;
    mfa?: boolean;
    id?: string;
  } = {},
) {
  const id = options.id ?? '00000000-0000-4000-8000-000000004001';
  const school = '00000000-0000-4000-8000-000000004002';
  const factor = '00000000-0000-4000-8000-000000004003';
  const state = {
    hasPassword: options.password !== false,
    email: 'account@example.test',
    pendingEmail: null as string | null,
    updates: [] as Record<string, unknown>[],
    recoveries: 0,
    otpEmails: 0,
    verifications: 0,
    reauthentications: 0,
    wrongIdentity: false,
    requireNonce: false,
    theme: 'system',
    rejectTheme: false,
    aal: options.mfa ? 'aal1' : 'aal2',
    confirmed: new Set<string>(),
    used: new Set<string>(),
  };
  const user = () => ({
    id: state.wrongIdentity ? '00000000-0000-4000-8000-000000009999' : id,
    email: state.email,
    email_confirmed_at: '2026-01-01T00:00:00Z',
    new_email: state.pendingEmail || undefined,
    aud: 'authenticated',
    role: 'authenticated',
    app_metadata: {
      provider: 'google',
      providers: state.hasPassword ? ['google', 'email'] : ['google'],
    },
    user_metadata: { vidyalayaa_theme: state.theme },
    identities: [
      {
        id: 'google-identity',
        provider: 'google',
        user_id: id,
        identity_data: { sub: 'google-fixture' },
      },
    ],
    created_at: '2026-01-01T00:00:00Z',
    factors: options.mfa
      ? [{ id: factor, factor_type: 'totp', status: 'verified', friendly_name: 'Authenticator' }]
      : [],
  });
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const session = () => {
    const encode = (x: unknown) => Buffer.from(JSON.stringify(x)).toString('base64url');
    return {
      user: user(),
      access_token: `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: id, aal: state.aal, exp })}.test-signature`,
      refresh_token: 'private-fixture-refresh',
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: exp,
    };
  };
  await page.addInitScript(
    (session) => {
      sessionStorage.setItem('vidyalayaa_splash_shown', '1');
      if (session) localStorage.setItem('sb-mfa-qr-auth-token', JSON.stringify(session));
    },
    options.signedIn === false ? null : session(),
  );
  await page.route('https://mfa-qr.test/auth/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const body = route.request().postDataJSON() || {};
    if (path.endsWith('/user')) {
      if (route.request().method() === 'PUT') {
        expect(route.request().headers().authorization).toBe(`Bearer ${session().access_token}`);
        if (body.data?.vidyalayaa_theme && state.rejectTheme)
          return route.fulfill({
            status: 503,
            json: { message: 'Appearance update unavailable.' },
          });
        if (
          body.password &&
          state.hasPassword &&
          !state.used.has('recovery-proof') &&
          body.current_password !== 'Old-password-123'
        )
          return route.fulfill({
            status: 422,
            json: { code: 'invalid_credentials', message: 'Current password is incorrect.' },
          });
        if (body.password && state.requireNonce && body.nonce !== '654321')
          return route.fulfill({
            status: 422,
            json: {
              code: 'reauthentication_needed',
              message: 'Request and enter an email verification code.',
            },
          });
        state.updates.push(body);
        if (body.email) state.pendingEmail = body.email;
        if (body.password) state.hasPassword = true;
        if (body.data?.vidyalayaa_theme) state.theme = body.data.vidyalayaa_theme;
      }
      return route.fulfill({ json: user() });
    }
    if (path.endsWith('/recover')) {
      state.recoveries++;
      expect(body.email).toBe(state.email);
      expect(url.searchParams.get('redirect_to')).toMatch(/\/auth\/callback$/);
      return route.fulfill({ json: {} });
    }
    if (path.endsWith('/reauthenticate')) {
      state.reauthentications++;
      return route.fulfill({ json: {} });
    }
    if (path.endsWith('/otp')) {
      state.otpEmails++;
      expect(body.create_user).toBe(false);
      return route.fulfill({ json: {} });
    }
    if (path.endsWith('/token')) return route.fulfill({ json: session() });
    if (path.endsWith('/logout')) return route.fulfill({ status: 204 });
    if (path.endsWith('/challenge'))
      return route.fulfill({
        json: { id: 'challenge-fixture', expires_at: Math.floor(Date.now() / 1000) + 60 },
      });
    if (path.includes('/factors/') && path.endsWith('/verify')) {
      expect(body.code).toBe('123456');
      state.aal = 'aal2';
      return route.fulfill({ json: session() });
    }
    if (path.endsWith('/verify')) {
      state.verifications++;
      const proof = body.token_hash || body.token;
      if (
        proof === 'expired-proof' ||
        state.used.has(proof) ||
        (!body.token_hash && body.token !== '123456')
      )
        return route.fulfill({
          status: 403,
          json: { code: 'otp_expired', message: 'Token has expired or is invalid' },
        });
      state.used.add(proof);
      if (body.type === 'email_change') {
        state.confirmed.add(proof);
        if (state.confirmed.size === 2) {
          state.email = state.pendingEmail!;
          state.pendingEmail = null;
        }
        return route.fulfill({ json: {} });
      }
      return route.fulfill({ json: session() });
    }
    throw new Error(`Unexpected provider request: ${path}`);
  });
  await page.route('**/api/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const role = options.role || 'school_admin';
    const membership = {
      school_id: school,
      school_name: 'Account test school',
      timezone: 'Asia/Kolkata',
      role,
      permissions: [],
    };
    if (path === '/api/v1/me')
      return route.fulfill({
        json: {
          id,
          email: state.email,
          full_name: 'Account test member',
          platform_role: role === 'SUPER_ADMIN' ? 'SUPER_ADMIN' : null,
          memberships: role === 'SUPER_ADMIN' || role === 'unassigned' ? [] : [membership],
          school: role === 'SUPER_ADMIN' || role === 'unassigned' ? null : membership,
          features: {},
          limits: {},
        },
      });
    if (path === '/api/v1/account/credentials')
      return route.fulfill({
        json: {
          email: state.email,
          has_password: state.hasPassword,
          pending_email: state.pendingEmail,
          email_confirmed: true,
        },
      });
    if (['/api/v1/invitations/pending', '/api/v1/support-access'].includes(path))
      return route.fulfill({ json: { data: [] } });
    return route.fulfill({
      status: 403,
      json: { error: { message: 'No test permission for this area' } },
    });
  });
  return state;
}

test('account theme saves, restores at first paint, and stays isolated on a shared browser', async ({
  page,
  authAppURL,
}) => {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  const first = await accountFixture(page, { signedIn: false });
  const root = page.locator('html');
  const nav = page.locator('.topbar').getByLabel('Theme');
  const settings = page.getByRole('main').getByRole('combobox', { name: 'Theme', exact: true });

  async function signIn() {
    await page.goto(authAppURL + '/login?returnTo=/settings/account');
    await page.getByLabel('Email address', { exact: true }).fill('account@example.test');
    await page.getByLabel('Password', { exact: true }).fill('Fixture-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(settings).toBeVisible();
  }

  async function signOut() {
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  }

  await signIn();
  await expect(settings).toHaveValue('system');
  await nav.selectOption('dark');
  await expect(root).toHaveAttribute('data-theme', 'dark');
  await expect(settings).toHaveValue('dark');
  await expect(nav).toBeEnabled();
  expect(first.theme).toBe('dark');
  expect(first.updates).toMatchObject([{ data: { vidyalayaa_theme: 'dark' } }]);

  first.rejectTheme = true;
  await settings.selectOption('light');
  await expect(page.getByRole('alert')).toContainText('appearance preference could not be saved');
  await expect(settings).toHaveValue('dark');
  await expect(root).toHaveAttribute('data-theme', 'dark');
  first.rejectTheme = false;

  // Stop the React entry once to check the server's document and paint stylesheet.
  const entry = await page.locator('script[type="module"][src]').last().getAttribute('src');
  await page.route(new URL(entry!, page.url()).href, (route) => route.abort(), { times: 1 });
  await page.reload();
  await expect(page.locator('#root')).toBeEmpty();
  await expect(root).toHaveAttribute('data-theme', 'dark');
  await expect(root).toHaveCSS('color-scheme', 'dark');
  await expect(root).toHaveCSS('background-color', 'rgb(0, 0, 0)');
  await page.reload();
  await expect(settings).toHaveValue('dark');
  await signOut();
  await expect(root).toHaveAttribute('data-theme', 'light');

  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('vidyalayaa.theme.')) localStorage.removeItem(key);
    }
  });
  await signIn();
  await expect(settings).toHaveValue('dark');
  await signOut();

  const second = await accountFixture(page, {
    signedIn: false,
    id: '00000000-0000-4000-8000-000000004009',
  });
  await signIn();
  await expect(settings).toHaveValue('system');
  await expect(root).toHaveAttribute('data-theme', 'light');
  await settings.selectOption('light');
  await expect(settings).toBeEnabled();
  expect(second.theme).toBe('light');
  expect(first.theme).toBe('dark');
});

for (const role of [
  'SUPER_ADMIN',
  'school_admin',
  'principal',
  'teacher',
  'parent',
  'student',
  'unassigned',
])
  test(`${role} can manage only their account from settings`, async ({ page, authAppURL }) => {
    await accountFixture(page, { role });
    await page.goto(authAppURL + '/settings/account');
    await expect(
      page.getByRole('heading', { name: 'Email & password', exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel('Current password', { exact: true })).toBeVisible();
    await expect(page.getByLabel('New email address', { exact: true })).toBeVisible();
    if (role === 'school_admin')
      expect(
        (await new AxeBuilder({ page }).include('#main-content').analyze()).violations,
      ).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    if (role === 'school_admin')
      await page.screenshot({
        path: `output/account-settings-${test.info().project.name}.png`,
        fullPage: true,
        animations: 'disabled',
        scale: 'css',
      });
  });

test('Google-only account creates a password only after its emailed proof is verified', async ({
  page,
  authAppURL,
}) => {
  const state = await accountFixture(page, { password: false });
  await page.goto(authAppURL + '/settings/account');
  await page.getByRole('button', { name: 'Send password setup link' }).click();
  await expect(page.getByRole('status')).toContainText('secure password setup link');
  expect(state.recoveries).toBe(1);
  expect(state.updates).toHaveLength(0);
  await page.goto(authAppURL + '/auth/verify#token_hash=recovery-proof&type=recovery');
  await expect(page).toHaveURL(authAppURL + '/auth/verify');
  expect(state.verifications).toBe(0);
  await expect(page.getByLabel('New password', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Confirm and continue' }).click();
  await page.getByLabel('New password', { exact: true }).fill('New-password-123');
  await page.getByLabel('Confirm password', { exact: true }).fill('New-password-123');
  await page.getByRole('button', { name: 'Set password & continue' }).click();
  await expect.poll(() => state.updates.length).toBe(1);
  expect(state.hasPassword).toBe(true);
  expect(state.updates[0]).toMatchObject({ password: 'New-password-123' });
  expect(state.updates[0]).not.toHaveProperty('data');
});

test('password change rejects wrong current passwords, handles reauthentication, and preserves identity', async ({
  page,
  authAppURL,
}) => {
  const state = await accountFixture(page);
  await page.goto(authAppURL + '/settings/account');
  await page.getByLabel('Current password', { exact: true }).fill('Incorrect-password');
  await page.getByLabel('New password', { exact: true }).fill('New-password-123');
  await page.getByLabel('Confirm new password', { exact: true }).fill('New-password-123');
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Current password');
  expect(state.updates).toHaveLength(0);
  state.requireNonce = true;
  await page.getByLabel('Current password', { exact: true }).fill('Old-password-123');
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('verification code');
  await page.getByRole('button', { name: 'Send verification code', exact: true }).click();
  await page.getByLabel('Email verification code', { exact: true }).fill('654321');
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('password has been changed');
  expect(state.reauthentications).toBe(1);
  expect(state.updates).toHaveLength(1);
  expect(
    await page.evaluate(() => Object.keys(localStorage).some((x) => /password|nonce/i.test(x))),
  ).toBe(false);
});

test('email remains unchanged until both address confirmations complete', async ({
  page,
  authAppURL,
}) => {
  const state = await accountFixture(page);
  await page.goto(authAppURL + '/settings/account');
  await page.getByLabel('New email address', { exact: true }).fill('new-account@example.test');
  await page.getByRole('button', { name: 'Send verification emails' }).click();
  await expect(page.getByRole('status')).toContainText('both your current and new inboxes');
  expect(state.email).toBe('account@example.test');
  for (const proof of ['new-address-proof', 'old-address-proof']) {
    await page.goto(authAppURL + `/auth/verify?token_hash=${proof}&type=email_change`);
    await page.getByRole('button', { name: 'Confirm and continue' }).click();
    await expect(page.getByRole('heading', { name: 'Email verification received.' })).toBeVisible();
    if (proof === 'new-address-proof') expect(state.email).toBe('account@example.test');
  }
  await page.goto(authAppURL + '/settings/account');
  await expect(page.getByText('new-account@example.test', { exact: true })).toBeVisible();
});

test('expired and reused links cannot turn a remembered session into password setup', async ({
  page,
  authAppURL,
}) => {
  const state = await accountFixture(page);
  await page.goto(authAppURL + '/auth/verify?token_hash=expired-proof&type=recovery');
  await page.getByRole('button', { name: 'Confirm and continue' }).click();
  await expect(page.getByRole('alert')).toContainText('expired');
  await expect(page.getByLabel('New password', { exact: true })).toHaveCount(0);
  expect(state.updates).toHaveLength(0);
  await page.goto(authAppURL + '/auth/verify?token_hash=invite-proof&type=invite');
  await page.getByRole('button', { name: 'Confirm and continue' }).click();
  await expect(page.getByLabel('New password', { exact: true })).toBeVisible();
  await page.goto(authAppURL + '/auth/verify?token_hash=invite-proof&type=invite');
  await page.getByRole('button', { name: 'Confirm and continue' }).click();
  await expect(page.getByRole('alert')).toContainText('already used');
  await expect(page.getByLabel('New password', { exact: true })).toHaveCount(0);
});

test('a changed signed-in identity prevents account writes', async ({ page, authAppURL }) => {
  const state = await accountFixture(page);
  await page.goto(authAppURL + '/settings/account');
  await page.getByLabel('New email address', { exact: true }).fill('new-account@example.test');
  state.wrongIdentity = true;
  await page.getByRole('button', { name: 'Send verification emails' }).click();
  await expect(page.getByRole('alert')).toContainText('sign-in changed');
  expect(state.updates).toHaveLength(0);
});

test('password recovery keeps enrolled authenticator verification', async ({
  page,
  authAppURL,
}) => {
  const state = await accountFixture(page, { mfa: true });
  await page.goto(authAppURL + '/auth/verify?token_hash=recovery-proof&type=recovery');
  await page.getByRole('button', { name: 'Confirm and continue' }).click();
  await page.getByLabel('New password', { exact: true }).fill('New-password-123');
  await page.getByLabel('Confirm password', { exact: true }).fill('New-password-123');
  await page.getByRole('button', { name: 'Set password & continue' }).click();
  await page.getByLabel('Authenticator code', { exact: true }).fill('123456');
  await page.getByRole('button', { name: 'Set password & continue' }).click();
  await expect.poll(() => state.updates.length).toBe(1);
  expect(state.aal).toBe('aal2');
});

test('email OTP sign-in does not create users and finishes through the existing MFA check', async ({
  page,
  authAppURL,
}) => {
  const state = await accountFixture(page, { signedIn: false });
  await page.goto(authAppURL + '/login?returnTo=%2Fsettings%2Faccount');
  await page.locator('summary').filter({ hasText: 'Sign in with an email link or code' }).click();
  await page.getByLabel('Email for sign-in link').fill('account@example.test');
  await page.getByRole('button', { name: 'Send sign-in email', exact: true }).click();
  await page.getByLabel('Email sign-in code').fill('123456');
  await page.getByRole('button', { name: 'Verify sign-in code' }).click();
  await expect(page.getByRole('heading', { name: 'Email & password', exact: true })).toBeVisible();
  expect(state.otpEmails).toBe(1);
});

test('existing-account invitation supports the default provider magic-link callback', async ({
  page,
  authAppURL,
}) => {
  const state = await accountFixture(page, { signedIn: false });
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const access = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: '00000000-0000-4000-8000-000000004001', aal: 'aal2', exp: Math.floor(Date.now() / 1000) + 3600 })}.fixture`;
  await page.goto(
    authAppURL +
      `/auth/verify#access_token=${access}&refresh_token=private-fixture-refresh&type=magiclink`,
  );
  await expect(page).toHaveURL(authAppURL + '/auth/verify');
  await expect(page.getByLabel('New password', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Confirm and continue' }).click();
  await expect(page.getByRole('link', { name: 'Continue to your account' })).toBeVisible();
  expect(state.updates).toHaveLength(0);
});
