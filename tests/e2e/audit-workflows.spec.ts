import { expect, type Page } from '@playwright/test';
import { test } from './fixtures/auth-app';
const school = '00000000-0000-4000-8000-000000000401',
  id = '00000000-0000-4000-8000-000000000402';
async function session(page: Page, role = 'school_admin') {
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
        : ['school.manage', 'students.read', 'students.write', 'reports.export', 'users.manage'],
  };
  await page.route('**/api/v1/me', (r) =>
    r.fulfill({
      json: {
        ...user,
        full_name: 'Audit operator',
        memberships: [membership],
        school: membership,
        platform_role: null,
        features: { assignments: true },
        limits: {},
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
  const calls: { rows: unknown[]; validate_only: boolean }[] = [];
  await page.route('**/api/v1/imports/students', async (r) => {
    const body = r.request().postDataJSON();
    calls.push(body);
    expect(r.request().headers()['idempotency-key']).toBeTruthy();
    await r.fulfill({ json: { validated: 1, imported: body.validate_only ? 0 : 1 } });
  });
  await page.goto(authAppURL + '/admin/r/students');
  await page.getByRole('button', { name: 'Import CSV', exact: true }).click();
  await page.getByLabel('CSV preview').fill('student_code,first_name\nS001,Synthetic learner');
  await expect(page.getByRole('button', { name: 'Import validated records' })).toBeDisabled();
  await page.getByRole('button', { name: 'Validate file', exact: true }).click();
  await expect(page.getByText('All rows validated. Ready to import.')).toBeVisible();
  await page.getByRole('button', { name: 'Import validated records' }).click();
  await expect(page.getByText('1 records imported.')).toBeVisible();
  expect(calls.map((x) => x.validate_only)).toEqual([true, false]);
  expect(calls[0].rows).toEqual(calls[1].rows);
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
test('School Admin records a school security policy reference', async ({ page, authAppURL }) => {
  await session(page);
  let policy = {
    require_privileged_mfa: false,
    student_login_enabled: true,
    step_up_sensitive: false,
    device_offline_minutes: 3,
    policy_ref: 'Initial fixture policy',
  };
  await page.route('**/api/v1/school/security', async (r) => {
    if (r.request().method() === 'PUT') policy = r.request().postDataJSON();
    await r.fulfill({ json: policy });
  });
  await page.goto(authAppURL + '/settings');
  await page.getByLabel('Require MFA for School Admins and Principals').check();
  await page.getByLabel('Require recent verification for sensitive changes').check();
  await page.getByLabel('Policy approval reference').fill('Approved isolated security policy');
  await page.getByRole('button', { name: 'Save security policy' }).click();
  await expect.poll(() => policy.require_privileged_mfa && policy.step_up_sensitive).toBe(true);
  expect(policy.policy_ref).toBe('Approved isolated security policy');
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
