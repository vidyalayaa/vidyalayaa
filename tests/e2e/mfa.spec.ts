import { expect, type Page } from '@playwright/test';
import { test } from './fixtures/auth-app';

type TestFactor = {
  id: string;
  friendly_name: string;
  factor_type: 'totp' | 'phone';
  status: 'verified' | 'unverified';
};

async function openSettings(page: Page, appURL: string, initialFactors: TestFactor[] = []) {
  // An inert SVG fixture, containing no TOTP secret or real provisioning information.
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180"><rect width="180" height="180" fill="white"/><path d="M20 20h50v50H20z" fill="black"/></svg>';
  const user = {
    id: '00000000-0000-4000-8000-000000000001',
    aud: 'authenticated',
    role: 'authenticated',
    email: 'mfa@example.test',
    app_metadata: {},
    user_metadata: {},
    created_at: '2026-01-01T00:00:00Z',
  };
  const session = {
    access_token: 'test-only-access-token',
    token_type: 'bearer',
    refresh_token: 'test-only-refresh-token',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user,
  };
  const state = {
    factors: structuredClone(initialFactors),
    enrollments: 0,
    removed: [] as string[],
    verified: false,
    failRemoval: false,
    failListing: false,
    failVerification: false,
  };
  await page.route('https://mfa-qr.test/auth/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    expect(request.headers().authorization).toBe(`Bearer ${session.access_token}`);
    let json: unknown;
    if (path === '/auth/v1/user') {
      if (state.failListing) {
        await route.fulfill({ status: 400, json: { message: 'Could not check authenticators.' } });
        return;
      }
      json = { ...user, factors: state.factors };
    } else if (path === '/auth/v1/factors' && request.method() === 'POST') {
      expect(request.postDataJSON()).toMatchObject({
        factor_type: 'totp',
        friendly_name: 'Vidyalayaa authenticator',
      });
      state.enrollments++;
      if (state.factors.some((factor) => factor.friendly_name === 'Vidyalayaa authenticator')) {
        await route.fulfill({
          status: 422,
          json: { message: 'A factor with this friendly name already exists.' },
        });
        return;
      }
      const factorId = `00000000-0000-4000-8000-${String(state.enrollments + 2).padStart(12, '0')}`;
      state.factors.push({
        id: factorId,
        friendly_name: 'Vidyalayaa authenticator',
        factor_type: 'totp',
        status: 'unverified',
      });
      json = { id: factorId, type: 'totp', totp: { qr_code: svg } };
    } else if (request.method() === 'DELETE') {
      const id = path.split('/').at(-1)!;
      const factor = state.factors.find((entry) => entry.id === id);
      expect(factor?.status).toBe('unverified');
      expect(factor?.friendly_name).toBe('Vidyalayaa authenticator');
      expect(factor?.factor_type).toBe('totp');
      if (state.failRemoval) {
        await route.fulfill({
          status: 400,
          json: { message: 'Could not restart authenticator setup.' },
        });
        return;
      }
      state.removed.push(id);
      state.factors = state.factors.filter((entry) => entry.id !== id);
      json = { id };
    } else if (path.endsWith('/challenge')) {
      expect(state.factors.some((entry) => entry.id === path.split('/').at(-2))).toBe(true);
      json = { id: 'test-challenge', expires_at: session.expires_at };
    } else if (path.endsWith('/verify')) {
      expect(request.postDataJSON()).toEqual({ challenge_id: 'test-challenge', code: '123456' });
      if (state.failVerification) {
        await route.fulfill({ status: 400, json: { message: 'Invalid authentication code.' } });
        return;
      }
      const factor = state.factors.find((entry) => entry.id === path.split('/').at(-2));
      expect(factor).toBeDefined();
      factor!.status = 'verified';
      state.verified = true;
      json = { ...session, user: { ...user, factors: state.factors } };
    } else throw new Error(`Unexpected test auth request: ${request.method()} ${path}`);
    await route.fulfill({ json, headers: { 'access-control-allow-origin': '*' } });
  });
  await page.route('**/api/v1/me', (route) =>
    route.fulfill({
      json: {
        id: user.id,
        full_name: 'MFA test account',
        email: user.email,
        memberships: [],
        school: null,
        platform_role: 'SUPER_ADMIN',
        features: [],
        limits: {},
      },
    }),
  );

  // Seed only this isolated browser context. All server auth requests are intercepted above.
  await page.addInitScript((testSession) => {
    localStorage.setItem('sb-mfa-qr-auth-token', JSON.stringify(testSession));
  }, session);
  await page.goto(`${appURL}/settings`);
  await expect(page.getByRole('heading', { name: 'Make it your school.' })).toBeVisible();
  return { state, svg };
}

test('setup renders the QR image, prevents duplicate clicks and persists enabled status', async ({
  page,
  authAppURL,
}) => {
  const { state, svg } = await openSettings(page, authAppURL);
  const setup = page.getByRole('button', { name: 'Set up authenticator' });
  await expect(setup).toBeEnabled();
  await setup.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });

  const image = page.getByRole('img', { name: 'Scan this QR code with your authenticator app' });
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBe(180);
  await expect(image).toHaveAttribute('src', `data:image/svg+xml;utf-8,${svg}`);
  expect(state.enrollments).toBe(1);
  await expect(setup).toHaveCount(0);

  state.failVerification = true;
  await page.getByLabel('Authenticator code').fill('123456');
  await page.getByRole('button', { name: 'Verify', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Invalid authentication code.');
  await expect(image).toBeVisible();
  state.failVerification = false;
  await page.getByRole('button', { name: 'Verify', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Authenticator enabled.');
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(state.verified).toBe(true);
  await expect(image).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('Authenticator enabled.');
  await expect(setup).toHaveCount(0);
  expect(state.enrollments).toBe(1);
  expect(state.removed).toEqual([]);
});

const unfinishedFactor: TestFactor = {
  id: '00000000-0000-4000-8000-000000000010',
  friendly_name: 'Vidyalayaa authenticator',
  factor_type: 'totp',
  status: 'unverified',
};

test('restarts interrupted setup after refresh while preserving unrelated factors', async ({
  page,
  authAppURL,
}) => {
  const unrelatedFactors: TestFactor[] = [
    { ...unfinishedFactor, id: 'other-totp', friendly_name: 'Another app' },
    { ...unfinishedFactor, id: 'phone', factor_type: 'phone', friendly_name: 'My phone' },
  ];
  const { state } = await openSettings(page, authAppURL, [unfinishedFactor, ...unrelatedFactors]);
  const resume = page.getByRole('button', { name: 'Continue authenticator setup' });
  await expect(page.getByText('An earlier setup wasn’t finished.', { exact: false })).toBeVisible();
  await resume.click();
  const image = page.getByRole('img', { name: 'Scan this QR code with your authenticator app' });
  await expect(image).toBeVisible();
  expect(state.removed).toEqual([unfinishedFactor.id]);
  expect(state.enrollments).toBe(1);
  const firstEnrollment = state.factors.find(
    (entry) => entry.friendly_name === unfinishedFactor.friendly_name,
  )!;

  // Losing the page's in-memory QR must not make subsequent enrollment fail.
  await page.reload();
  await resume.click();
  await expect(image).toBeVisible();
  expect(state.removed).toEqual([unfinishedFactor.id, firstEnrollment.id]);
  expect(state.enrollments).toBe(2);
  expect(
    state.factors.filter((entry) => unrelatedFactors.some((other) => other.id === entry.id)),
  ).toEqual(unrelatedFactors);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

for (const name of ['Vidyalayaa authenticator', 'Existing authenticator']) {
  test(`preserves an enabled factor named ${name}`, async ({ page, authAppURL }) => {
    const { state } = await openSettings(page, authAppURL, [
      { ...unfinishedFactor, friendly_name: name, status: 'verified' },
    ]);
    await expect(page.getByRole('status')).toHaveText('Authenticator enabled.');
    await expect(
      page.getByRole('button', { name: /authenticator setup|Set up authenticator/ }),
    ).toHaveCount(0);
    expect(state.enrollments).toBe(0);
    expect(state.removed).toEqual([]);
  });
}

test('stops on cleanup errors and clears the error after a successful retry', async ({
  page,
  authAppURL,
}) => {
  const { state } = await openSettings(page, authAppURL, [unfinishedFactor]);
  state.failRemoval = true;
  const resume = page.getByRole('button', { name: 'Continue authenticator setup' });
  await resume.click();
  await expect(page.getByRole('alert')).toHaveText('Could not restart authenticator setup.');
  expect(state.enrollments).toBe(0);
  expect(state.removed).toEqual([]);
  state.failRemoval = false;
  await resume.click();
  await expect(page.getByRole('img')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(state.enrollments).toBe(1);
});

test('rechecks factors before enrollment and stops if the check fails', async ({
  page,
  authAppURL,
}) => {
  const { state } = await openSettings(page, authAppURL);
  const setup = page.getByRole('button', { name: 'Set up authenticator' });
  await expect(setup).toBeEnabled();
  state.failListing = true;
  await setup.click();
  await expect(page.getByRole('alert')).toHaveText('Could not check authenticators.');
  expect(state.enrollments).toBe(0);
  expect(state.removed).toEqual([]);

  // A factor enabled in another tab must be preserved, even if the initial check was empty.
  state.failListing = false;
  state.factors.push({ ...unfinishedFactor, status: 'verified' });
  await setup.click();
  await expect(page.getByRole('status')).toHaveText('Authenticator enabled.');
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(state.enrollments).toBe(0);
  expect(state.removed).toEqual([]);
});
