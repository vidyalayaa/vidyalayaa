import { expect, type Page } from '@playwright/test';
import { securityPolicyDefaults } from '@vidyalayaa/contracts';
import { test } from './fixtures/auth-app';
const school = '00000000-0000-4000-8000-000000000401',
  id = '00000000-0000-4000-8000-000000000402';
async function session(
  page: Page,
  role = 'school_admin',
  idle?: { deadline: string; expired: boolean },
) {
  const user = {
    id,
    email: 'audit-flow@example.test',
    aud: 'authenticated',
    role: 'authenticated',
    app_metadata: {},
    user_metadata: {},
    created_at: '2026-01-01T00:00:00Z',
    factors: [],
  };
  await page.addInitScript(
    (value) => localStorage.setItem('sb-mfa-qr-auth-token', JSON.stringify(value)),
    {
      user,
      access_token: 'audit-test-token',
      refresh_token: 'audit-test-refresh',
      token_type: 'bearer',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      expires_in: 3600,
    },
  );
  await page.route('https://mfa-qr.test/auth/v1/user', (r) => r.fulfill({ json: user }));
  const membership = {
    school_id: school,
    school_name: 'Audit workflow school',
    timezone: 'Asia/Kolkata',
    role,
    permissions:
      role === 'parent'
        ? ['students.read', 'attendance.read', 'assignments.read']
        : [
            'school.manage',
            'students.read',
            'students.write',
            'parents.read',
            'parents.write',
            'academics.read',
            'reports.export',
            'users.manage',
          ],
  };
  await page.route('**/api/v1/me', (r) =>
    idle?.expired
      ? r.fulfill({
          status: 401,
          json: {
            error: { code: 'SESSION_ENDED', message: 'Your session ended after inactivity.' },
          },
        })
      : r.fulfill({
          json: {
            ...user,
            full_name: 'Audit operator',
            memberships: [membership],
            school: membership,
            platform_role: null,
            features: { assignments: true },
            limits: {},
            idle_expires_at: idle?.deadline,
          },
        }),
  );
  await page.route('**/api/v1/profile/family', (r) =>
    r.fulfill({ json: { profile: null, children: [] } }),
  );
}
const empty = { data: [], page: 1, page_size: 25, total: 0 };
test('School Admin validates an import before committing the same rows', async ({
  page,
  authAppURL,
}) => {
  await session(page);
  await page.route('**/api/v1/resources/students?**', (r) => r.fulfill({ json: empty }));
  await page.route('**/api/v1/student-directory/classes?**', (r) =>
    r.fulfill({ json: { ...empty, unassigned_count: 0 } }),
  );
  const calls: { rows: unknown[]; validate_only: boolean }[] = [];
  await page.route('**/api/v1/student-directory/imports', async (r) => {
    const body = r.request().postDataJSON();
    calls.push(body);
    expect(r.request().headers()['idempotency-key']).toBeTruthy();
    await r.fulfill({ json: { validated: 1, imported: body.validate_only ? 0 : 1 } });
  });
  await page.goto(authAppURL + '/admin/r/students');
  await page.getByRole('button', { name: 'Import CSV', exact: true }).click();
  await page
    .getByLabel('CSV preview')
    .fill(
      'student_code,first_name,class_grade,class_section,starts_on,parent_1_full_name\nS001,Synthetic learner,8,A,2026-01-01,Fixture parent',
    );
  await expect(page.getByRole('button', { name: 'Import validated records' })).toBeDisabled();
  await page.getByRole('button', { name: 'Validate file', exact: true }).click();
  await expect(page.getByText('All rows validated. Ready to import.')).toBeVisible();
  await page.getByRole('button', { name: 'Import validated records' }).click();
  await expect(
    page.getByText('1 student imported with class enrollments and family connections.'),
  ).toBeVisible();
  expect(calls.map((x) => x.validate_only)).toEqual([true, false]);
  expect(calls[0].rows).toEqual(calls[1].rows);
});
test('inactivity shows a countdown, extends only on confirmed Cancel, then signs out', async ({
  page,
  authAppURL,
}) => {
  const start = Date.now();
  await page.clock.install({ time: start });
  const idle = { deadline: new Date(start + 120_000).toISOString(), expired: false };
  await session(page, 'parent', idle);
  await page.route('https://mfa-qr.test/auth/v1/logout**', (r) => r.fulfill({ status: 204 }));
  let activities = 0;
  await page.route('**/api/v1/account/sessions/activity', (r) => {
    activities++;
    if (activities === 2)
      return r.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE' } } });
    idle.deadline = new Date(start + (activities === 1 ? 180_000 : 360_000)).toISOString();
    return r.fulfill({ json: { idle_expires_at: idle.deadline } });
  });
  await page.goto(authAppURL + '/settings');
  await expect(page.getByRole('heading', { name: 'Account security', exact: true })).toBeVisible();
  const warning = page.getByRole('dialog', { name: 'You’re about to be signed out' });
  await expect(warning).toHaveCount(0);
  await page.keyboard.press('Shift');
  await expect.poll(() => activities).toBe(1);
  await page.clock.fastForward(125_000);
  await expect(warning).toBeVisible();
  const timer = warning.getByRole('timer');
  await expect(timer).toContainText(/0:[0-5][0-9]/);
  const displayedTime = await timer.textContent();
  await page.clock.fastForward(5_000);
  await expect(timer).not.toHaveText(displayedTime || '');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Shift');
  await expect(warning).toBeVisible();
  expect(activities).toBe(1);
  await warning.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(warning.getByRole('alert')).toContainText('Could not extend your session.');
  await warning.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(warning).not.toBeVisible();
  expect(activities).toBe(3);
  await page.clock.fastForward(180_000);
  await expect(warning).toBeVisible();
  idle.expired = true;
  await page.clock.fastForward(65_000);
  await expect(page).toHaveURL(/\/login/);
});
test('School Admin creates a reasoned private school export', async ({ page, authAppURL }) => {
  await session(page);
  await page.route('**/api/v1/exports?**', (r) => r.fulfill({ json: empty }));
  await page.route('**/api/v1/offboarding?**', (r) => r.fulfill({ json: empty }));
  let saved: unknown;
  await page.route('**/api/v1/exports', async (r) => {
    saved = r.request().postDataJSON();
    await r.fulfill({ status: 201, json: { id: crypto.randomUUID(), status: 'PENDING' } });
  });
  await page.goto(authAppURL + '/admin/exports');
  await page.getByRole('button', { name: 'Create school export', exact: true }).click();
  await page.getByLabel('Format', { exact: true }).selectOption('CSV');
  await page.getByLabel('Reason', { exact: true }).fill('Approved isolated export exercise');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  expect(saved).toEqual({ format: 'CSV', reason: 'Approved isolated export exercise' });
});
test('School Admin confirms a restrictive security policy and sees the saved version after refresh', async ({
  page,
  authAppURL,
}) => {
  await session(page);
  let policy = {
    ...securityPolicyDefaults,
    policy_ref: 'Initial fixture policy',
    version: 0,
    approved_at: null as string | null,
    approved_by_name: null as string | null,
    recovery_ready: false,
  };
  await page.route('**/api/v1/school/security', async (r) => {
    if (r.request().method() === 'PUT') {
      const input = r.request().postDataJSON();
      expect(input).toMatchObject({ expected_version: 0, confirm_enforcement: true });
      policy = {
        ...policy,
        ...input,
        version: 1,
        approved_at: new Date().toISOString(),
        approved_by_name: 'Audit operator',
      };
    }
    await r.fulfill({ json: policy });
  });
  await page.route('**/api/v1/school/security/history?**', (r) =>
    r.fulfill({ json: { data: [policy], more: false } }),
  );
  await page.goto(authAppURL + '/settings');
  await page.getByLabel('Require MFA for School Admins and Principals').check();
  await page.getByRole('button', { name: 'Save security policy' }).click();
  await expect(page.getByRole('alert')).toContainText('second active School Admin');
  await page.getByLabel('Require MFA for School Admins and Principals').uncheck();
  await page.getByLabel('Allow parent accounts to sign in').uncheck();
  await page.getByLabel('Inactivity timeout (minutes)', { exact: false }).fill('25');
  await page.getByLabel('Policy approval reference').fill('Approved isolated security policy');
  await page.getByRole('button', { name: 'Save security policy' }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm security enforcement' });
  await expect(dialog).toContainText('lose access to this school immediately');
  expect(policy.version).toBe(0);
  await dialog.getByRole('button', { name: 'Confirm and save' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Security policy saved.' }),
  ).toBeVisible();
  expect(policy.parent_login_enabled).toBe(false);
  expect(policy.policy_ref).toBe('Approved isolated security policy');
  await page.reload();
  await expect(page.getByLabel('Allow parent accounts to sign in')).not.toBeChecked();
  await expect(page.getByLabel('Inactivity timeout (minutes)', { exact: false })).toHaveValue('25');
  await expect(page.getByText('Updated by Audit operator')).toBeVisible();
  await page.getByText('Policy version history', { exact: true }).click();
  await expect(page.getByText('Version 1 · Approved isolated security policy')).toBeVisible();
});
test('Parent controls only their lock-screen privacy preference', async ({ page, authAppURL }) => {
  await session(page, 'parent');
  let preference = true;
  await page.route('**/api/v1/profile/preferences', async (r) => {
    if (r.request().method() === 'PUT')
      preference = r.request().postDataJSON().no_names_on_lock_screen;
    await r.fulfill({ json: { no_names_on_lock_screen: preference } });
  });
  await page.goto(authAppURL + '/settings');
  const control = page.getByLabel('Hide school update details on the lock screen.', {
    exact: false,
  });
  await expect(control).toBeChecked({ timeout: 15000 });
  await control.uncheck();
  await expect.poll(() => preference).toBe(false);
  await expect(page.getByRole('button', { name: 'Save security policy' })).toHaveCount(0);
});
