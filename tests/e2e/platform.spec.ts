import { expect, type Page } from '@playwright/test';
import { test } from './fixtures/auth-app';
const id = '00000000-0000-4000-8000-000000000301',
  school = '00000000-0000-4000-8000-000000000302';
async function platformSession(page: Page) {
  const user = {
    id,
    email: 'platform-flow@example.test',
    aud: 'authenticated',
    role: 'authenticated',
    app_metadata: {},
    user_metadata: {},
    created_at: '2026-01-01T00:00:00Z',
  };
  await page.addInitScript(
    (value) => localStorage.setItem('sb-mfa-qr-auth-token', JSON.stringify(value)),
    {
      user,
      access_token: 'platform-test-token',
      refresh_token: 'platform-test-refresh',
      token_type: 'bearer',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      expires_in: 3600,
    },
  );
  await page.route('https://mfa-qr.test/auth/v1/user', (r) => r.fulfill({ json: user }));
  await page.route('**/api/v1/me', (r) =>
    r.fulfill({
      json: {
        ...user,
        full_name: 'Platform operator',
        platform_role: 'SUPER_ADMIN',
        memberships: [],
        school: null,
        features: {},
        limits: {},
      },
    }),
  );
  await page.route('**/api/v1/platform/schools?**', (r) =>
    r.fulfill({ json: { data: [], total: 0, page: 1, page_size: 25 } }),
  );
}

test('Super Admin reads the approved before and after audit details', async ({
  page,
  authAppURL,
}) => {
  await platformSession(page);
  await page.route('**/api/v1/platform/audit?**', (route) =>
    route.fulfill({
      json: {
        data: [
          {
            id,
            occurred_at: '2026-10-20T09:00:00Z',
            actor_id: id,
            action: 'device.revoke',
            entity_type: 'devices',
            reason: 'Approved isolated reader change',
            request_id: id,
            before: { status: 'ACTIVE' },
            after: { status: 'REVOKED' },
          },
        ],
        page: 1,
        page_size: 25,
        total: 1,
      },
    }),
  );
  await page.goto(authAppURL + '/platform/audit');
  await page.getByRole('button', { name: 'View change', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('device.revoke');
  await expect(dialog).toContainText('"ACTIVE"');
  await expect(dialog).toContainText('"REVOKED"');
});
test('Super Admin edits named plan controls and sees processing health', async ({
  page,
  authAppURL,
}) => {
  await platformSession(page);
  let saved = false;
  const plan = {
    id,
    code: 'PROFESSIONAL',
    name: 'Professional',
    is_active: true,
    features: { nfc_attendance: true, parent_alerts: true },
    limits: { max_devices: 10, report_retention_days: 180 },
  };
  await page.route('**/api/v1/platform/plans**', async (r) => {
    if (r.request().method() === 'PATCH') {
      expect(r.request().postDataJSON()).toMatchObject({
        limits: { max_devices: 12 },
        features: { parent_alerts: false },
        reason: 'Approved plan update',
      });
      saved = true;
      return r.fulfill({ json: { ...plan, limits: { ...plan.limits, max_devices: 12 } } });
    }
    return r.fulfill({ json: { data: [plan] } });
  });
  await page.route('**/api/v1/platform/operations', (r) =>
    r.fulfill({
      json: {
        metrics: { schools: 2, notification_backlog: 3, dead_notifications: 0 },
        workers: [],
        server_time: '2026-10-18T10:00:00Z',
      },
    }),
  );
  await page.goto(`${authAppURL}/platform`);
  await page.getByRole('button', { name: 'plans', exact: true }).click();
  await page.getByRole('button', { name: 'Edit plan', exact: true }).click();
  await page.getByLabel('Max Devices', { exact: true }).fill('12');
  await page.getByLabel('Parent Alerts', { exact: true }).uncheck();
  await page.getByLabel('Reason for change', { exact: true }).fill('Approved plan update');
  await page.getByRole('button', { name: 'Save plan', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(saved).toBe(true);
  await page.getByRole('button', { name: 'health', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Platform health', exact: true })).toBeVisible();
  await expect(page.getByText('Notification Backlog', { exact: true })).toBeVisible();
  await expect(
    page.getByText('No worker heartbeat has been received.', { exact: false }),
  ).toBeVisible();
});
test('Super Admin sets up a school with no subscription and sees the saved values', async ({
  page,
  authAppURL,
}) => {
  await platformSession(page);
  const plan = {
    id,
    code: 'PROFESSIONAL',
    name: 'Professional',
    is_active: true,
    features: {},
    limits: { max_devices: 10, max_campuses: 1, max_students: 1000, report_retention_days: 180 },
  };
  let saved: Record<string, unknown> | undefined;
  await page.route('**/api/v1/platform/plans', (r) => r.fulfill({ json: { data: [plan] } }));
  await page.route('**/api/v1/platform/schools?**', (r) =>
    r.fulfill({
      json: {
        data: [
          {
            id: school,
            name: 'Unconfigured school',
            school_code: 'SETUP',
            timezone: 'Asia/Kolkata',
            plan_id: saved ? id : null,
            plan: saved ? plan.name : null,
            subscription_status: saved?.status ?? null,
            ...saved,
            admin_onboarding: { state: 'assigned' },
          },
        ],
        total: 1,
        page: 1,
        page_size: 25,
      },
    }),
  );
  await page.route(`**/api/v1/platform/schools/${school}/subscription`, (r) => {
    expect(r.request().method()).toBe('PATCH');
    saved = r.request().postDataJSON();
    expect(saved).toEqual({
      plan_id: id,
      status: 'ACTIVE',
      current_period_end: '2026-10-30T07:29:00.000Z',
      grace_ends_at: '2026-10-30T07:30:00.000Z',
      limit_overrides: {
        max_devices: 10,
        max_campuses: 1,
        max_students: 1000,
        report_retention_days: 120,
      },
      reason: 'Approved initial subscription',
      billing_ref: null,
      export_until: null,
    });
    return r.fulfill({
      json: { id: '00000000-0000-4000-8000-000000000303', school_id: school, ...saved },
    });
  });
  await page.goto(`${authAppURL}/platform/schools`);
  await page.getByRole('button', { name: 'Subscription', exact: true }).click();
  await expect(
    page.getByText('This school has no subscription yet.', { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Plan', exact: true })).toHaveValue('');
  await page.getByRole('combobox', { name: 'Plan', exact: true }).selectOption(id);
  await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('ACTIVE');
  await page.getByLabel('Current period ends', { exact: true }).fill('2026-10-30T12:59');
  await page.getByLabel('Grace period ends (optional)', { exact: true }).fill('2026-10-30T13:00');
  await page.getByLabel('Max Devices', { exact: true }).fill('10');
  await page.getByLabel('Max Campuses', { exact: true }).fill('1');
  await page.getByLabel('Max Students', { exact: true }).fill('1000');
  await page.getByLabel('Report Retention Days', { exact: true }).fill('120');
  await page.getByLabel('Reason for change', { exact: true }).fill('Approved initial subscription');
  await page.getByRole('button', { name: 'Save subscription', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('ACTIVE', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Subscription', exact: true }).click();
  await expect(
    page.getByText('This school has no subscription yet.', { exact: false }),
  ).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Plan', exact: true })).toHaveValue(id);
  await expect(page.getByLabel('Report Retention Days', { exact: true })).toHaveValue('120');
  await expect(page.getByLabel('Current period ends', { exact: true })).toHaveValue(
    '2026-10-30T12:59',
  );
});

test('support view hides records as soon as a grant expires', async ({ page, authAppURL }) => {
  await platformSession(page);
  await page.clock.install();
  const expires = new Date(Date.now() + 60000).toISOString();
  await page.route('**/api/v1/platform/support-grants?**', (r) =>
    r.fulfill({
      json: {
        data: [
          {
            id,
            school_id: school,
            ticket_ref: 'APPROVED-TEST',
            reason: 'Review a scoped fixture',
            scope: ['students'],
            approved_by: id,
            expires_at: expires,
          },
        ],
        total: 1,
        page: 1,
        page_size: 25,
      },
    }),
  );
  await page.route(`**/api/v1/platform/support-grants/${id}/students?**`, (r) =>
    r.fulfill({
      json: {
        data: [
          { id, first_name: 'Scoped test learner', student_code: 'TEST001', status: 'ACTIVE' },
        ],
        total: 1,
        page: 1,
        page_size: 25,
      },
    }),
  );
  await page.goto(`${authAppURL}/platform`);
  await page.getByRole('button', { name: 'support grants', exact: true }).click();
  await page.getByRole('button', { name: 'Open approved access', exact: true }).click();
  await expect(page.getByText('Scoped test learner', { exact: true })).toBeVisible();
  await page.clock.fastForward(65000);
  await expect(page.getByText('This support grant has expired.', { exact: false })).toBeVisible();
  await expect(page.getByText('Scoped test learner', { exact: true })).toHaveCount(0);
});
