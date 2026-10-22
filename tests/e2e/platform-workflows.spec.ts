import { expect, type Page } from '@playwright/test';
import { test } from './fixtures/platform-app';

async function save(page: Page) {
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test('platform header search and notices stay in the Super Admin workspace', async ({
  page,
  authAppURL,
  isMobile,
}) => {
  await page.goto(authAppURL + '/platform');
  if (isMobile) {
    await page.getByRole('textbox', { name: 'Find school', exact: true }).fill('Test School A');
  } else {
    await page.getByRole('textbox', { name: 'Search schools', exact: true }).fill('Test School A');
    await page.getByRole('textbox', { name: 'Search schools', exact: true }).press('Enter');
    await expect(page).toHaveURL(/\/platform\/schools\?search=Test/);
  }
  await expect(page.getByRole('row').filter({ hasText: 'Test School A' })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Test School B' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Notifications', exact: true }).click();
  await expect(page).toHaveURL(/\/platform\/notices$/);
  await expect(page.getByRole('main')).toContainText(/Device Alert/i);
  await expect(page.getByRole('main')).toContainText('Test School A');
});

test('creates a school and prepares then cancels its first administrator invitation', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  await page.goto(authAppURL + '/platform/schools');
  await page.getByRole('button', { name: 'Add school', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('School Code', { exact: true }).fill('UI_NEW');
  await dialog.getByLabel('Name', { exact: true }).fill('New Website School');
  await dialog.getByLabel('Trial Ends At', { exact: true }).fill('2099-12-01T12:00');
  await save(page);
  const row = page.getByRole('row').filter({ hasText: 'New Website School' });
  await row.getByRole('button', { name: 'Invite School Admin' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Full name', { exact: true }).fill('First school administrator');
  await dialog.getByLabel('Email address', { exact: true }).fill('setup-admin@example.test');
  await dialog.getByRole('button', { name: 'Invite School Admin', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('The setup email has been sent');
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await row.getByRole('button', { name: 'Manage invitation' }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Cancel invitation', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'Invite School Admin' })).toBeVisible();
  const result = await platformApp.request('/platform/schools?search=UI_NEW');
  expect(result.body.data[0]).toMatchObject({
    name: 'New Website School',
    subscription_status: 'TRIALING',
    admin_onboarding: { state: 'missing' },
  });
});

test('manual subscriptions preserve payment references and enforce terminal export dates', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  const plans = await platformApp.request('/platform/plans');
  const enterprise = plans.body.data.find((p: { code: string }) => p.code === 'ENTERPRISE');
  await page.goto(authAppURL + '/platform/schools');
  const row = page.getByRole('row').filter({ hasText: 'Test School A' });
  await row.getByRole('button', { name: 'Subscription', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: 'Plan', exact: true }).selectOption(enterprise.id);
  await dialog.getByRole('combobox', { name: 'Status', exact: true }).selectOption('ACTIVE');
  await dialog.getByLabel('Current period ends', { exact: true }).fill('2099-12-01T12:00');
  await dialog.getByLabel('Max Devices', { exact: true }).fill('12');
  await dialog
    .getByLabel('Payment or contract reference (optional)', { exact: true })
    .fill('UI-CASH-001');
  await dialog
    .getByLabel('Reason for change', { exact: true })
    .fill('Approved manual subscription upgrade');
  await dialog.getByRole('button', { name: 'Save subscription', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await row.getByRole('button', { name: 'Subscription', exact: true }).click();
  await expect(
    page.getByLabel('Payment or contract reference (optional)', { exact: true }),
  ).toHaveValue('UI-CASH-001');
  await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('CANCELLED');
  await expect(page.getByLabel('Contractual export deadline', { exact: false })).toHaveAttribute(
    'required',
    '',
  );
  await page.getByLabel('Contractual export deadline', { exact: false }).fill('2100-01-01T12:00');
  await page
    .getByLabel('Reason for change', { exact: true })
    .fill('Approved terminal subscription contract');
  await page.getByRole('button', { name: 'Save subscription', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  let terminal = (await platformApp.request('/platform/schools?search=Test%20School%20A')).body
    .data[0];
  expect(terminal.subscription_status).toBe('CANCELLED');
  expect(terminal.export_until).toBeTruthy();
  await row.getByRole('button', { name: 'Subscription', exact: true }).click();
  await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('ACTIVE');
  await page
    .getByLabel('Reason for change', { exact: true })
    .fill('Approved manual subscription reactivation');
  await page.getByRole('button', { name: 'Save subscription', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const result = await platformApp.request('/platform/schools?search=Test%20School%20A');
  expect(result.body.data[0]).toMatchObject({
    billing_ref: 'UI-CASH-001',
    plan_code: 'ENTERPRISE',
    subscription_status: 'ACTIVE',
    limit_overrides: { max_devices: 12 },
  });
});

test('campus groups can be created, assigned, retained when reopened and removed', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  expect(
    (
      await platformApp.request(
        `/platform/schools/${platformApp.records.schoolA}/subscription`,
        'PATCH',
        {
          plan_code: 'ENTERPRISE',
          status: 'ACTIVE',
          current_period_end: '2099-12-01T00:00:00Z',
          reason: 'Approved generated Enterprise campus setup',
        },
      )
    ).status,
  ).toBe(200);
  await page.goto(authAppURL + '/platform/organizations');
  await page.getByRole('button', { name: 'Add organization', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Z Browser Campus Group');
  await save(page);
  const group = (
    await platformApp.request('/platform/organizations?search=Z%20Browser%20Campus%20Group')
  ).body.data.find((r: { name: string }) => r.name === 'Z Browser Campus Group');
  await page.goto(authAppURL + '/platform/schools');
  const row = page.getByRole('row').filter({ hasText: 'Test School A' });
  await row.getByRole('button', { name: 'Campus group', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Find Organization', exact: true })
    .fill('Z Browser Campus Group');
  await page.locator('#action-organization_id').selectOption(group.id);
  await page
    .getByRole('dialog')
    .getByLabel('Reason', { exact: true })
    .fill('Approved Enterprise campus association');
  await save(page);
  await row.getByRole('button', { name: 'Campus group', exact: true }).click();
  await expect(page.locator('#action-organization_id')).toHaveValue(group.id);
  await page.locator('#action-organization_id').selectOption('');
  await page
    .getByRole('dialog')
    .getByLabel('Reason', { exact: true })
    .fill('Approved removal from campus association');
  await save(page);
  const result = await platformApp.request('/platform/schools?search=Test%20School%20A');
  expect(result.body.data[0].organization_id).toBeNull();
});

test('device inventory validates input, shows credentials once, rotates and revokes', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  await page.goto(authAppURL + '/platform/devices');
  await page.getByRole('button', { name: 'Register hardware', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.locator('#action-school_id').selectOption(platformApp.records.schoolA);
  await dialog.getByLabel('Device Code', { exact: true }).fill('bad-code');
  await dialog.getByLabel('Name', { exact: true }).fill('Browser Gate Reader');
  await dialog.getByLabel('Hardware Serial', { exact: true }).fill('TEST-SERIAL-001');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await dialog.getByLabel('Device Code', { exact: true }).fill('UI_READER');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Provisioning credentials' });
  const first = await dialog.locator('code').nth(1).innerText();
  expect(first.length).toBeGreaterThan(20);
  await dialog.getByRole('button', { name: 'I have stored these securely' }).click();
  const row = page.getByRole('row').filter({ hasText: 'Browser Gate Reader' });
  await row.getByRole('button', { name: 'Rotate credential' }).click();
  await page
    .getByRole('dialog')
    .getByLabel('Reason', { exact: true })
    .fill('Approved generated credential rotation');
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Provisioning credentials' });
  const rotated = await dialog.locator('code').nth(1).innerText();
  expect(rotated).not.toBe(first);
  await dialog.getByRole('button', { name: 'I have stored these securely' }).click();
  await expect(page.getByRole('main')).not.toContainText(first);
  await row.getByRole('button', { name: 'Revoke', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByLabel('Reason', { exact: true })
    .fill('Approved generated reader retirement');
  await save(page);
  await expect(row.getByRole('button', { name: 'Rotate credential' })).toBeDisabled();
  const device = (await platformApp.request('/platform/devices')).body.data.find(
    (r: { device_code: string }) => r.device_code === 'UI_READER',
  );
  expect(device.status).toBe('REVOKED');
  expect(
    (
      await platformApp.request(`/platform/devices/${device.id}/rotate`, 'POST', {
        reason: 'Must not rotate a revoked reader',
      })
    ).status,
  ).toBe(409);
});

test('support tickets display the question and save the platform response', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  await page.goto(authAppURL + '/platform/support-requests');
  const row = page.getByRole('row').filter({ hasText: 'Platform support fixture' });
  await row.getByRole('button', { name: 'Respond', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Please review the administrator account setup.');
  await dialog.getByRole('combobox', { name: 'Status', exact: true }).selectOption('RESOLVED');
  await dialog.getByLabel('Response', { exact: true }).fill('The account setup has been reviewed.');
  await dialog.getByRole('button', { name: 'Save response', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toContainText(/Resolved/i);
  const result = await platformApp.request('/platform/support-requests');
  expect(
    result.body.data.find((r: { id: string }) => r.id === platformApp.supportTicket),
  ).toMatchObject({ status: 'RESOLVED', response: 'The account setup has been reviewed.' });
});

test('support access requires school approval and revocation takes effect immediately', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  await page.goto(authAppURL + '/platform/support-grants');
  await page.getByRole('button', { name: 'Request access', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('#action-school_id').selectOption(platformApp.records.schoolA);
  await dialog.getByLabel('Reason', { exact: true }).fill('Investigate generated support record');
  await dialog.getByLabel('Ticket Ref', { exact: true }).fill('SUP-UI');
  await save(page);
  let row = page.getByRole('row').filter({ hasText: 'SUP-UI' });
  await expect(row.getByRole('button', { name: 'Open approved access' })).toBeDisabled();
  const grant = (await platformApp.request('/platform/support-grants')).body.data.find(
    (g: { ticket_ref: string }) => g.ticket_ref === 'SUP-UI',
  );
  expect((await platformApp.request(`/platform/support-grants/${grant.id}/students`)).status).toBe(
    404,
  );
  expect(
    (
      await platformApp.request(
        `/support-grants/${grant.id}/decision`,
        'POST',
        { approve: true },
        platformApp.records.admin,
        platformApp.records.schoolA,
      )
    ).status,
  ).toBe(200);
  await page.reload();
  row = page.getByRole('row').filter({ hasText: 'SUP-UI' });
  await row.getByRole('button', { name: 'Open approved access' }).click();
  await expect(page.getByRole('dialog')).toContainText('Test learner');
  expect((await platformApp.request(`/platform/support-grants/${grant.id}/marks`)).status).toBe(
    404,
  );
  expect(
    (
      await platformApp.request(
        `/support-grants/${grant.id}/decision`,
        'POST',
        { approve: false },
        platformApp.records.admin,
        platformApp.records.schoolA,
      )
    ).status,
  ).toBe(200);
  expect((await platformApp.request(`/platform/support-grants/${grant.id}/students`)).status).toBe(
    404,
  );
  await page.reload();
  await expect(
    page
      .getByRole('row')
      .filter({ hasText: 'SUP-UI' })
      .getByRole('button', { name: 'Open approved access' }),
  ).toBeDisabled();
});

test('closure requires school approval, keeps holds and blocks premature deletion', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  await page.goto(authAppURL + '/platform/schools');
  await page
    .getByRole('row')
    .filter({ hasText: 'Closure Website School' })
    .getByRole('button', { name: 'Closure request' })
    .click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Policy Ref', { exact: true }).fill('UI-CLOSURE-CONTRACT');
  await dialog
    .getByLabel('Reason', { exact: true })
    .fill('Approved generated school closure request');
  await dialog.getByLabel('Export Until', { exact: true }).fill('2099-11-01T12:00');
  await dialog.getByLabel('Delete After', { exact: true }).fill('2099-12-01T12:00');
  await save(page);
  await page.goto(authAppURL + '/platform/offboarding');
  let row = page.getByRole('row').filter({ hasText: 'Closure Website School' });
  await expect(row.getByRole('button', { name: 'Close school', exact: true })).toBeDisabled();
  const job = (await platformApp.request('/platform/offboarding')).body.data.find(
    (j: { policy_ref: string }) => j.policy_ref === 'UI-CLOSURE-CONTRACT',
  );
  expect(
    (
      await platformApp.request(
        `/offboarding/${job.id}/approve`,
        'POST',
        { approve: true, policy_ref: job.policy_ref },
        platformApp.records.admin,
        job.school_id,
      )
    ).status,
  ).toBe(204);
  await page.reload();
  row = page.getByRole('row').filter({ hasText: 'Closure Website School' });
  await row.getByRole('button', { name: 'Close school', exact: true }).click();
  await save(page);
  await expect(row).toContainText(/Closed/i);
  await row.getByRole('button', { name: 'Legal hold', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Enabled', { exact: true }).selectOption('false');
  await dialog
    .getByLabel('Reason', { exact: true })
    .fill('Approved removal of generated legal hold');
  await save(page);
  await expect(row.getByRole('button', { name: 'Request data deletion' })).toBeDisabled();
  const unknown = await platformApp.request(
    '/platform/offboarding/00000000-0000-4000-8000-000000000099/close',
    'POST',
    { confirm: 'CLOSE_SCHOOL' },
  );
  expect(unknown.status).toBe(404);
});

test('eligible school deletion is queued only through the explicit confirmation', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  await page.goto(authAppURL + '/platform/offboarding');
  const row = page.getByRole('row').filter({ hasText: 'Test School B' });
  await row.getByRole('button', { name: 'Request data deletion' }).click();
  await page
    .getByRole('dialog')
    .getByLabel('Reason', { exact: true })
    .fill('Approved generated operational purge request');
  await save(page);
  await expect(row).toContainText(/Purge Requested/i);
  expect(
    (await platformApp.request('/platform/offboarding')).body.data.find(
      (j: { id: string }) => j.id === platformApp.purgeJob,
    ).status,
  ).toBe('PURGE_REQUESTED');
});

test('plans, persisted usage, health, audit details and deferred firmware metadata open', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  await page.goto(authAppURL + '/platform/plans');
  const row = page.getByRole('row').filter({ hasText: 'Professional' });
  await row.getByRole('button', { name: 'Edit plan', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Max Devices', { exact: true }).fill('11');
  await dialog
    .getByLabel('Reason for change', { exact: true })
    .fill('Approved generated plan update');
  await dialog.getByRole('button', { name: 'Save plan', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.goto(authAppURL + '/platform/usage');
  await expect(page.getByRole('main')).toContainText('321');
  await page.goto(authAppURL + '/platform/health');
  await expect(page.getByRole('heading', { name: 'Platform health' })).toBeVisible();
  await expect(page.getByRole('main')).toContainText('No worker heartbeat');
  await page.goto(authAppURL + '/platform/audit');
  await page.getByRole('button', { name: 'View change', exact: true }).first().click();
  dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Request ID');
  await page.goto(authAppURL + '/platform/firmware');
  await expect(page.getByRole('heading', { name: 'Signed firmware releases' })).toBeVisible();
  expect((await platformApp.request('/platform/firmware-releases')).status).toBe(200);
});

test('every platform read denies school roles and requires Super Admin MFA', async ({
  platformApp,
}) => {
  const paths = [
    'schools',
    'devices',
    'plans',
    'support-grants',
    'support-requests',
    'notices',
    'audit',
    'organizations',
    'usage',
    'offboarding',
    'operations',
    'firmware-releases',
  ];
  for (const path of paths) {
    for (const user of [
      platformApp.records.admin,
      platformApp.records.principal,
      platformApp.records.teacher,
      platformApp.records.parent,
      platformApp.records.studentUser,
    ])
      expect(
        (
          await platformApp.request(
            '/platform/' + path,
            'GET',
            undefined,
            user,
            platformApp.records.schoolA,
          )
        ).status,
        path,
      ).toBe(403);
    expect(
      (
        await platformApp.request(
          '/platform/' + path,
          'GET',
          undefined,
          platformApp.root,
          undefined,
          'aal1',
        )
      ).status,
      path,
    ).toBe(403);
  }
  for (const path of [
    '/platform/organizations',
    '/platform/devices',
    '/platform/support-grants',
    '/platform/offboarding/' + platformApp.purgeJob + '/purge',
  ])
    expect(
      (
        await platformApp.request(
          path,
          'POST',
          {},
          platformApp.records.admin,
          platformApp.records.schoolA,
        )
      ).status,
      path,
    ).toBe(403);
  expect((await fetch(platformApp.url + '/api/v1/platform/schools')).status).toBe(401);
});

test('a Super Admin with an explicit school role keeps platform navigation and privacy', async ({
  page,
  authAppURL,
  platformApp,
  isMobile,
}) => {
  const parent = await platformApp.request(
    '/resources/parents',
    'POST',
    { full_name: 'Platform parent fixture', email: 'platform@example.test' },
    platformApp.records.admin,
    platformApp.records.schoolA,
  );
  expect(parent.status).toBe(201);
  expect(
    (
      await platformApp.request(
        '/resources/student_parents',
        'POST',
        {
          student_id: platformApp.records.student,
          parent_id: parent.body.id,
          relationship: 'GUARDIAN',
        },
        platformApp.records.admin,
        platformApp.records.schoolA,
      )
    ).status,
  ).toBe(201);
  const invite = await platformApp.request(
    '/invitations',
    'POST',
    {
      record_id: parent.body.id,
      full_name: 'Platform parent fixture',
      email: 'platform@example.test',
      role: 'parent',
    },
    platformApp.records.admin,
    platformApp.records.schoolA,
  );
  expect(invite.status).toBe(201);
  expect(
    (
      await platformApp.request('/invitations/' + invite.body.id + '/respond', 'POST', {
        accept: true,
      })
    ).status,
  ).toBe(200);
  await page.goto(authAppURL + '/platform/schools');
  if (isMobile) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await expect(
    page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: 'Schools', exact: true }),
  ).toHaveAttribute('href', '/platform/schools');
  await expect(page.getByRole('navigation', { name: 'Family navigation' })).toHaveCount(0);
  if (isMobile) {
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: 'Schools', exact: true })
      .click();
  }
  await expect(
    page.getByRole('textbox', { name: isMobile ? 'Find school' : 'Search schools', exact: true }),
  ).toBeVisible();
});

test('Super Admin sign-out clears the browser session and returns to login', async ({
  page,
  authAppURL,
}) => {
  await page.goto(authAppURL + '/platform/schools');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  const confirmBtn = page.getByRole('dialog').getByRole('button', { name: 'Sign out', exact: true });
  if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await confirmBtn.click();
  }
  await expect(page).toHaveURL(/\/login/);
  expect(await page.evaluate(() => localStorage.getItem('sb-mfa-qr-auth-token'))).toBeNull();
});
