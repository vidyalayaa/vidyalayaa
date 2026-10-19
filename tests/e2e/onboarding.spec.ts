import { expect, type Page } from '@playwright/test';
import { test } from './fixtures/auth-app';

const school = '00000000-0000-4000-8000-000000000101';
const invitation = '00000000-0000-4000-8000-000000000102';
async function signedIn(page: Page) {
  const user = {
    id: '00000000-0000-4000-8000-000000000103',
    email: 'onboarding@example.test',
    aud: 'authenticated',
    role: 'authenticated',
    app_metadata: {},
    user_metadata: {},
    created_at: '2026-01-01T00:00:00Z',
    factors: [],
  };
  const session = {
    user,
    access_token: 'test-only-onboarding-token',
    refresh_token: 'test-only-refresh',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  };
  await page.addInitScript(
    (value) => localStorage.setItem('sb-mfa-qr-auth-token', JSON.stringify(value)),
    session,
  );
  await page.route('https://mfa-qr.test/auth/v1/user', (route) => route.fulfill({ json: user }));
  return user;
}

test('Super Admin can invite and cancel the first school administrator from the website', async ({
  page,
  authAppURL,
}) => {
  const user = await signedIn(page);
  let sent = 0;
  let onboarding: Record<string, unknown> = { state: 'missing' };
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/me')
      await route.fulfill({
        json: {
          ...user,
          full_name: 'Platform operator',
          memberships: [],
          platform_role: 'SUPER_ADMIN',
          school: null,
          features: {},
          limits: {},
        },
      });
    else if (path === '/api/v1/invitations/pending') await route.fulfill({ json: { data: [] } });
    else if (path === '/api/v1/platform/schools')
      await route.fulfill({
        json: {
          data: [
            {
              id: school,
              school_code: 'NEW',
              name: 'New partner school',
              timezone: 'Asia/Kolkata',
              plan: 'Professional',
              subscription_status: 'TRIALING',
              admin_onboarding: onboarding,
            },
            {
              id: 'already-staffed',
              school_code: 'STAFFED',
              name: 'Staffed school',
              admin_onboarding: { state: 'assigned' },
            },
          ],
        },
      });
    else if (path.endsWith('/administrator-invitation')) {
      expect(route.request().postDataJSON()).toEqual({
        email: 'colleague@example.test',
        full_name: 'School colleague',
        resend: false,
      });
      sent++;
      onboarding = {
        state: 'invited',
        invitation_id: invitation,
        email: 'colleague@example.test',
        full_name: 'School colleague',
        status: 'SENT',
      };
      await route.fulfill({
        status: 201,
        json: { id: invitation, status: 'SENT', email_sent: true },
      });
    } else if (path.endsWith(`/${invitation}/cancel`)) {
      onboarding = { state: 'missing' };
      await route.fulfill({ status: 204 });
    } else throw new Error(`Unexpected onboarding test request: ${path}`);
  });
  await page.goto(`${authAppURL}/platform`);
  const row = page.getByRole('row').filter({ hasText: 'New partner school' });
  await row.getByRole('button', { name: 'Invite School Admin' }).click();
  await page.getByLabel('Full name', { exact: true }).fill('School colleague');
  await page.getByLabel('Email address', { exact: true }).fill('Colleague@Example.test');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Invite School Admin', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText('The setup email has been sent.');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await row.getByRole('button', { name: 'Manage invitation' }).click();
  await page.getByRole('button', { name: 'Cancel invitation', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'Invite School Admin' })).toBeVisible();
  await expect(
    page.getByRole('row').filter({ hasText: 'Staffed school' }).getByText('School Admin assigned'),
  ).toBeVisible();
  expect(sent).toBe(1);
});

test('an invited Principal accepts their school before opening its workspace', async ({
  page,
  authAppURL,
}) => {
  const user = await signedIn(page);
  let accepted = false;
  const membership = {
    school_id: school,
    school_name: 'Inviting school',
    timezone: 'Asia/Kolkata',
    role: 'principal',
    permissions: ['attendance.read', 'students.read'],
  };
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/me')
      await route.fulfill({
        json: {
          ...user,
          full_name: 'Invited Principal',
          platform_role: null,
          memberships: accepted ? [membership] : [],
          school: accepted ? membership : null,
          features: {},
          limits: {},
        },
      });
    else if (path === '/api/v1/invitations/pending')
      await route.fulfill({
        json: {
          data: accepted
            ? []
            : [
                {
                  id: invitation,
                  school_id: school,
                  school_name: 'Inviting school',
                  role_code: 'principal',
                  expires_at: '2099-01-01T00:00:00Z',
                },
              ],
        },
      });
    else if (path.endsWith(`/${invitation}/respond`)) {
      expect(route.request().postDataJSON()).toEqual({ accept: true });
      accepted = true;
      await route.fulfill({ json: { school_id: school, accepted: true, role: 'principal' } });
    } else if (path === '/api/v1/dashboard')
      await route.fulfill({
        json: {
          date: '2026-10-18',
          stats: { students: 0, present: 0, late: 0, absent: 0 },
          trend: [],
          recent: [],
          notices: [],
          deviceHealth: null,
        },
      });
    else throw new Error(`Unexpected recipient test request: ${path}`);
  });
  await page.goto(authAppURL);
  await expect(page.getByText('Principal invitation', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Accept invitation', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Welcome back, Invited/ })).toBeVisible();
  expect(accepted).toBe(true);
  await expect(page.getByRole('button', { name: 'Accept invitation' })).toHaveCount(0);
});
