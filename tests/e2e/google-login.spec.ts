import { expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { test } from './fixtures/auth-app';

const userId = '00000000-0000-4000-8000-000000000701';
const factorId = '00000000-0000-4000-8000-000000000702';
const schoolId = '00000000-0000-4000-8000-000000000703';
type Role = 'school_admin' | 'principal' | 'teacher' | 'parent' | 'student' | 'SUPER_ADMIN' | null;
async function fixture(page: Page, role: Role = 'school_admin', mfa = false) {
  const user = {
    id: userId,
    email: 'google-login@example.test',
    aud: 'authenticated',
    role: 'authenticated',
    app_metadata: { provider: 'google' },
    user_metadata: {},
    created_at: '2026-01-01T00:00:00Z',
    factors: mfa
      ? [
          {
            id: factorId,
            factor_type: 'totp',
            friendly_name: 'Vidyalayaa authenticator',
            status: 'verified',
          },
        ]
      : [],
  };
  const state = {
    enabled: true,
    redirect: '',
    challenge: '',
    exchanges: 0,
    verified: false,
    rejectExchange: false,
    rejectUser: false,
    rejectFactors: false,
    passwordLogins: 0,
    codeChecks: 0,
    protectedReads: 0,
  };
  const session = (aal: string) => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    return {
      user,
      access_token: `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: userId, exp, aal, role: 'authenticated' })}.inert-test-signature`,
      refresh_token: 'inert-test-refresh',
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: exp,
    };
  };
  await page.route('https://mfa-qr.test/auth/v1/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.pathname.endsWith('/settings'))
      return route.fulfill({ json: { external: { google: state.enabled, email: true } } });
    if (url.pathname.endsWith('/authorize')) {
      expect(url.searchParams.get('provider')).toBe('google');
      expect(url.searchParams.get('scopes')).toBe('openid email profile');
      expect(url.searchParams.get('prompt')).toBe('select_account');
      expect(url.searchParams.get('code_challenge_method')?.toLowerCase()).toBe('s256');
      expect(url.searchParams.has('access_type')).toBe(false);
      state.redirect = url.searchParams.get('redirect_to')!;
      state.challenge = url.searchParams.get('code_challenge')!;
      return route.fulfill({ contentType: 'text/html', body: '<h1>Isolated Google sign-in</h1>' });
    }
    if (url.pathname.endsWith('/token')) {
      if (url.searchParams.get('grant_type') === 'password') {
        expect(request.postDataJSON()).toMatchObject({
          email: user.email,
          password: 'Fixture-password-123',
        });
        state.passwordLogins++;
      } else {
        expect(url.searchParams.get('grant_type')).toBe('pkce');
        expect(request.postDataJSON().auth_code).toBe('isolated-google-code');
        expect(
          createHash('sha256').update(request.postDataJSON().code_verifier).digest('base64url'),
        ).toBe(state.challenge);
        state.exchanges++;
        if (state.rejectExchange)
          return route.fulfill({
            status: 400,
            json: { code: 'bad_code_verifier', message: 'Invalid fixture exchange' },
          });
      }
      return route.fulfill({ json: session('aal1') });
    }
    if (url.pathname.endsWith('/user')) {
      expect(request.method()).toBe('GET'); // OAuth must never set/reset a password.
      if (state.rejectUser || state.rejectFactors)
        return route.fulfill({ status: 401, json: { message: 'Fixture security check failed' } });
      return route.fulfill({ json: user });
    }
    if (url.pathname.endsWith('/challenge')) {
      expect(url.pathname).toContain(factorId);
      return route.fulfill({
        json: { id: 'fixture-challenge', expires_at: Math.floor(Date.now() / 1000) + 300 },
      });
    }
    if (url.pathname.endsWith('/verify')) {
      state.codeChecks++;
      expect(request.postDataJSON().challenge_id).toBe('fixture-challenge');
      if (request.postDataJSON().code !== '123456')
        return route.fulfill({ status: 422, json: { message: 'Invalid authentication code.' } });
      state.verified = true;
      return route.fulfill({ json: session('aal2') });
    }
    throw new Error('Unexpected fixture auth route: ' + url.pathname);
  });
  const membership =
    role && role !== 'SUPER_ADMIN'
      ? {
          school_id: schoolId,
          school_name: 'Google fixture school',
          role,
          timezone: 'Asia/Kolkata',
          permissions: [],
        }
      : null;
  await page.route('**/api/v1/me', (r) => {
    if (mfa && !state.verified)
      return r.fulfill({
        status: 403,
        json: {
          error: {
            code: 'MFA_REQUIRED',
            message: 'Complete multi-factor authentication to continue.',
          },
        },
      });
    state.protectedReads++;
    return r.fulfill({
      json: {
        id: userId,
        email: user.email,
        full_name: 'Google fixture user',
        platform_role: role === 'SUPER_ADMIN' ? role : null,
        memberships: membership ? [membership] : [],
        school: membership,
        features: {},
        limits: {},
      },
    });
  });
  return {
    state,
    user,
    session,
    async start(appURL: string, returnTo = '/settings') {
      await page.goto(`${appURL}/login?returnTo=${encodeURIComponent(returnTo)}`);
      await page.getByRole('button', { name: 'Continue with Google', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Isolated Google sign-in' })).toBeVisible();
      expect(new URL(state.redirect).origin).toBe(appURL);
      expect(new URL(state.redirect).pathname).toBe('/auth/google/callback');
      const callback = new URL(state.redirect);
      callback.searchParams.set('code', 'isolated-google-code');
      await page.goto(callback.toString());
    },
  };
}

for (const [role, portal] of [
  ['school_admin', 'admin'],
  ['principal', 'principal'],
  ['teacher', 'teacher'],
  ['parent', 'parent'],
  ['student', 'student'],
  ['SUPER_ADMIN', ''],
] as const) {
  test(`Google login preserves ${role} access and enrolled MFA`, async ({ page, authAppURL }) => {
    const { start, state } = await fixture(page, role, true);
    await start(authAppURL);
    await expect(page.getByLabel('Authentication code', { exact: true })).toBeVisible();
    await expect(page.getByLabel('New password', { exact: true })).toHaveCount(0);
    expect(state.protectedReads).toBe(0);
    await page.getByLabel('Authentication code', { exact: true }).fill('000000');
    await page.getByRole('button', { name: 'Verify & continue' }).click();
    await expect(page.getByRole('alert')).toContainText('Invalid authentication code.');
    await page.getByLabel('Authentication code', { exact: true }).fill('123456');
    await page.getByRole('button', { name: 'Verify & continue' }).click();
    await expect(page).toHaveURL(`${authAppURL}${portal ? '/' + portal : ''}/settings`);
    await expect(
      page.getByRole('heading', { name: 'Account security', exact: true }),
    ).toBeVisible();
    expect(state.exchanges).toBe(1);
    expect(state.passwordLogins).toBe(0);
    expect(state.verified).toBe(true);
    expect(page.url()).not.toContain('code=');
  });
}

test('a Google account without membership receives no school role', async ({
  page,
  authAppURL,
}) => {
  const { start, state } = await fixture(page, null);
  await start(authAppURL);
  await expect(
    page.getByRole('heading', { name: 'Choose your school', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Accept an invitation above, or ask your school administrator to invite you.'),
  ).toBeVisible();
  expect(state.exchanges).toBe(1);
});

test('an unavailable Google provider keeps email sign-in usable', async ({ page, authAppURL }) => {
  const { state, user } = await fixture(page);
  state.enabled = false;
  await page.goto(`${authAppURL}/login`);
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page.getByRole('alert')).toContainText('Google sign-in is not available yet.');
  await expect(page).toHaveURL(`${authAppURL}/login`);
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
  await page.getByLabel('Email address', { exact: true }).fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill('Fixture-password-123');
  state.rejectFactors = true;
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Could not check account security.');
  await expect(page).toHaveURL(`${authAppURL}/login`);
  expect(state.passwordLogins).toBe(1);
});

test('email/password still challenges an enrolled authenticator', async ({ page, authAppURL }) => {
  const { state, user } = await fixture(page, 'teacher', true);
  await page.goto(`${authAppURL}/login?returnTo=%2Fsettings`);
  await page.getByLabel('Email address', { exact: true }).fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill('Fixture-password-123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Authentication code', { exact: true }).fill('123456');
  await page.getByRole('button', { name: 'Verify & continue' }).click();
  await expect(page).toHaveURL(`${authAppURL}/teacher/settings`);
  expect(state.passwordLogins).toBe(1);
  expect(state.exchanges).toBe(0);
});

for (const suffix of ['', '?error=access_denied&error_description=private-provider-error']) {
  test(`Google callback rejects missing/cancelled authentication ${suffix ? 'cancelled' : 'missing'} even with an existing session`, async ({
    page,
    authAppURL,
  }) => {
    const { state, session } = await fixture(page);
    await page.addInitScript(
      (value) => localStorage.setItem('sb-mfa-qr-auth-token', JSON.stringify(value)),
      session('aal1'),
    );
    await page.goto(`${authAppURL}/auth/google/callback${suffix}`);
    await expect(page.getByRole('alert')).toContainText(
      'Google sign-in was cancelled or could not be completed.',
    );
    await expect(page).toHaveURL(`${authAppURL}/auth/google/callback`);
    await expect(page.getByLabel('New password', { exact: true })).toHaveCount(0);
    expect(state.exchanges).toBe(0);
  });
}

test('a rejected PKCE exchange never opens a workspace', async ({ page, authAppURL }) => {
  const { start, state } = await fixture(page);
  state.rejectExchange = true;
  await start(authAppURL);
  await expect(page.getByRole('alert')).toContainText('expired or is invalid');
  await expect(page).toHaveURL(`${authAppURL}/auth/google/callback`);
  expect(state.protectedReads).toBe(0);
  expect(state.exchanges).toBe(1);
});
