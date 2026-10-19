import { expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { test } from './fixtures/auth-app';

async function authFixture(page: Page, appURL: string, existingSession = false) {
  const user = {
    id: '00000000-0000-4000-8000-000000000021',
    email: 'invited-admin@example.test',
    aud: 'authenticated',
    role: 'authenticated',
    app_metadata: {},
    user_metadata: {},
    created_at: '2026-01-01T00:00:00Z',
    factors: [],
  };
  const expires = Math.floor(Date.now() / 1000) + 3600;
  // Unsigned, inert fixture tokens accepted only by the intercepted test provider.
  const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const access = `${encoded({ alg: 'HS256', typ: 'JWT' })}.${encoded({ sub: user.id, exp: expires, role: 'authenticated', aal: 'aal1' })}.test-only-signature`;
  const session = {
    user,
    access_token: access,
    refresh_token: 'test-only-refresh-token',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: expires,
  };
  const state = {
    updates: 0,
    exchanges: 0,
    rejectUser: false,
    rejectPassword: false,
    changedAccount: false,
    recoveryURL: '',
    challenge: '',
  };
  await page.route('https://mfa-qr.test/auth/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith('/user')) {
      if (state.rejectUser) {
        await route.fulfill({ status: 401, json: { message: 'Invalid test session.' } });
      } else if (request.method() === 'PUT') {
        expect(request.postDataJSON().password).toBe('A-test-only-password-123');
        expect(request.headers().authorization).toBe(`Bearer ${access}`);
        state.updates++;
        await route.fulfill(
          state.rejectPassword
            ? { status: 422, json: { message: 'Please choose a different password.' } }
            : { json: user },
        );
      } else {
        await route.fulfill({
          json: state.changedAccount ? { ...user, id: 'another-signed-in-account' } : user,
        });
      }
    } else if (url.pathname.endsWith('/token')) {
      expect(url.searchParams.get('grant_type')).toBe('pkce');
      const body = request.postDataJSON();
      expect(body.auth_code).toBe('test-only-callback-code');
      expect(createHash('sha256').update(body.code_verifier).digest('base64url')).toBe(
        state.challenge,
      );
      state.exchanges++;
      await route.fulfill({ json: session });
    } else if (url.pathname.endsWith('/recover')) {
      expect(request.postDataJSON().email).toBe(user.email);
      state.recoveryURL = url.searchParams.get('redirect_to')!;
      state.challenge = request.postDataJSON().code_challenge;
      expect(state.challenge).toBeTruthy();
      expect(request.postDataJSON().code_challenge_method).toBe('s256');
      expect(new URL(state.recoveryURL).origin).toBe(appURL);
      await route.fulfill({ json: {} });
    } else
      throw new Error(`Unexpected auth callback test request: ${request.method()} ${url.pathname}`);
  });
  await page.route('**/api/v1/me', (route) =>
    route.fulfill({
      json: {
        id: user.id,
        email: user.email,
        full_name: 'Invited administrator',
        platform_role: 'SUPER_ADMIN',
        memberships: [],
        school: null,
        features: {},
        limits: {},
      },
    }),
  );
  if (existingSession) {
    await page.addInitScript((value) => {
      localStorage.setItem('sb-mfa-qr-auth-token', JSON.stringify(value));
    }, session);
  }
  return {
    state,
    user,
    link: (type: 'invite' | 'recovery') =>
      `${appURL}/auth/callback#${new URLSearchParams({
        type,
        access_token: access,
        refresh_token: session.refresh_token,
        expires_in: '3600',
        token_type: 'bearer',
      })}`,
  };
}

for (const type of ['invite', 'recovery'] as const) {
  test(`accepts a verified ${type} token fragment and saves the chosen password`, async ({
    page,
    authAppURL,
  }) => {
    const { state, user, link } = await authFixture(page, authAppURL);
    await page.goto(link(type));
    await expect(page.getByLabel('New password', { exact: true })).toBeVisible();
    await expect(
      page.getByText(`Choose your Vidyalayaa password for ${user.email}.`),
    ).toBeVisible();
    await expect(page).toHaveURL(`${authAppURL}/auth/callback`);
    await page.getByLabel('New password', { exact: true }).fill('A-test-only-password-123');
    await page.getByLabel('Confirm password').fill('A-different-test-password');
    await page.getByRole('button', { name: 'Set password & continue' }).click();
    await expect(page.getByRole('alert')).toHaveText('The passwords do not match.');
    expect(state.updates).toBe(0);
    await page.getByLabel('Confirm password').fill('A-test-only-password-123');
    state.rejectPassword = true;
    await page.getByRole('button', { name: 'Set password & continue' }).click();
    await expect(page.getByRole('alert')).toHaveText('Please choose a different password.');
    state.rejectPassword = false;
    await page.getByRole('button', { name: 'Set password & continue' }).click();
    await expect(page).toHaveURL(`${authAppURL}/settings`);
    await expect(page.getByRole('button', { name: 'Set up authenticator' })).toBeEnabled();
    expect(state.updates).toBe(2);
  });
}

for (const explicitFlowId of [false, true]) {
  test(`exchanges a recovery PKCE code once with explicit flow ID ${explicitFlowId}`, async ({
    page,
    authAppURL,
  }) => {
    const { state, user } = await authFixture(page, authAppURL);
    await page.goto(`${authAppURL}/login?recovery=1`);
    await page.getByLabel('Email address').fill(user.email);
    await page.getByRole('button', { name: 'Send recovery link' }).click();
    await expect(page.getByRole('status')).toHaveText(
      'If this account exists, a recovery link has been sent.',
    );
    const callback = new URL(state.recoveryURL);
    if (explicitFlowId) {
      const flowId = await page.evaluate(() => {
        const flows = JSON.parse(localStorage.getItem('sb-mfa-qr-auth-token-flows-code-verifier')!);
        // Simulate another pending flow. The requested slot must still be used.
        localStorage.setItem(
          'sb-mfa-qr-auth-token-code-verifier',
          JSON.stringify('another-verifier/recovery'),
        );
        return flows[0] as string;
      });
      expect(flowId).toBeTruthy();
      callback.searchParams.set('sb_flow_id', flowId);
    }
    callback.searchParams.set('code', 'test-only-callback-code');
    await page.goto(callback.toString());
    await expect(page.getByLabel('New password', { exact: true })).toBeVisible();
    await expect(page).toHaveURL(`${authAppURL}/auth/callback`);
    expect(state.exchanges).toBe(1);
  });
}

for (const suffix of [
  '#error=access_denied&error_code=otp_expired&error_description=Sensitive-provider-details',
  '',
  '?code=missing-browser-verifier',
]) {
  test(`rejects an unusable callback with an existing session: ${suffix || 'missing link'}`, async ({
    page,
    authAppURL,
  }) => {
    const { state } = await authFixture(page, authAppURL, true);
    await page.goto(`${authAppURL}/auth/callback${suffix}`);
    await expect(page.getByRole('alert')).toContainText(/setup link|verify this setup link/);
    await expect(page.getByLabel('New password', { exact: true })).toHaveCount(0);
    await expect(page).toHaveURL(`${authAppURL}/auth/callback`);
    expect(state.updates).toBe(0);
    expect(state.exchanges).toBe(0);
    await page.getByRole('link', { name: 'Request a new setup link' }).click();
    await expect(page.getByRole('button', { name: 'Send recovery link' })).toBeVisible();
  });
}

test('rejects an invitation session that the provider cannot verify', async ({
  page,
  authAppURL,
}) => {
  const { state, link } = await authFixture(page, authAppURL);
  state.rejectUser = true;
  await page.goto(link('invite'));
  await expect(page.getByRole('alert')).toContainText('We could not verify this setup link.');
  await expect(page.getByLabel('New password', { exact: true })).toHaveCount(0);
  expect(state.updates).toBe(0);
});

test('does not update a different account if sign-in changes during password setup', async ({
  page,
  authAppURL,
}) => {
  const { state, link } = await authFixture(page, authAppURL);
  await page.goto(link('invite'));
  await page.getByLabel('New password', { exact: true }).fill('A-test-only-password-123');
  await page.getByLabel('Confirm password').fill('A-test-only-password-123');
  state.changedAccount = true;
  await page.getByRole('button', { name: 'Set password & continue' }).click();
  await expect(page.getByRole('alert')).toContainText('Your sign-in changed.');
  await expect(page.getByLabel('New password', { exact: true })).toHaveCount(0);
  expect(state.updates).toBe(0);
});
