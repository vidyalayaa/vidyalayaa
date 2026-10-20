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

for (const role of ['parent', 'student', 'teacher', 'principal'])
  test(`School Admin invites the selected existing ${role} record`, async ({
    page,
    authAppURL,
  }) => {
    await session(page);
    await page.route('**/api/v1/memberships?**', (r) => r.fulfill({ json: empty }));
    await page.route('**/api/v1/invitations?**', (r) => r.fulfill({ json: empty }));
    await page.route('**/api/v1/invitation-candidates?**', (r) => {
      const selectedRole = new URL(r.request().url()).searchParams.get('role');
      return r.fulfill({
        json: {
          ...empty,
          total: 1,
          data: [
            {
              id,
              full_name: `Existing ${selectedRole}`,
              email: `${selectedRole}@example.test`,
              code: 'REC-1',
            },
          ],
        },
      });
    });
    let submitted = false;
    await page.route('**/api/v1/invitations', (r) => {
      expect(r.request().postDataJSON()).toEqual({
        role,
        record_id: id,
        full_name: `Existing ${role}`,
        email: `${role}@example.test`,
      });
      submitted = true;
      return r.fulfill({ status: 201, json: { id, status: 'SENT', email_sent: true } });
    });
    await page.goto(authAppURL + '/admin/members');
    await page.getByRole('button', { name: 'Invite member', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Role', { exact: true }).selectOption(role);
    await expect(
      dialog.getByRole('button', { name: 'Send invitation', exact: true }),
    ).toBeDisabled();
    await dialog.getByLabel('Existing school record', { exact: true }).selectOption(id);
    await expect(dialog).toContainText(`${role}@example.test`);
    await expect(dialog.getByRole('textbox', { name: 'Email', exact: true })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Send invitation', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(submitted).toBe(true);
    await expect(page.getByRole('status')).toContainText('Acceptance will link the account');
  });

test('Invitation cannot be sent without an eligible school record', async ({
  page,
  authAppURL,
}) => {
  await session(page);
  await page.route('**/api/v1/memberships?**', (r) => r.fulfill({ json: empty }));
  await page.route('**/api/v1/invitations?**', (r) => r.fulfill({ json: empty }));
  await page.route('**/api/v1/invitation-candidates?**', (r) => r.fulfill({ json: empty }));
  await page.goto(authAppURL + '/admin/members');
  await page.getByRole('button', { name: 'Invite member', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('No eligible records');
  await expect(dialog.getByRole('button', { name: 'Send invitation', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('link', { name: 'Add or update school records' })).toHaveAttribute(
    'href',
    '/admin/r/teachers',
  );
});

test('Paging through candidates never submits the invitation form', async ({
  page,
  authAppURL,
}) => {
  await session(page);
  await page.route('**/api/v1/memberships?**', (r) => r.fulfill({ json: empty }));
  await page.route('**/api/v1/invitations?**', (r) => r.fulfill({ json: empty }));
  await page.route('**/api/v1/invitation-candidates?**', (r) => {
    const current = Number(new URL(r.request().url()).searchParams.get('page'));
    return r.fulfill({
      json: {
        data: [
          {
            id,
            full_name: `Page ${current} teacher`,
            email: 'teacher@example.test',
            code: 'STAFF',
          },
        ],
        page: current,
        page_size: 25,
        total: 50,
      },
    });
  });
  let sends = 0;
  await page.route('**/api/v1/invitations', (r) => {
    sends++;
    return r.fulfill({ status: 500, json: { error: { message: 'Unexpected invitation send' } } });
  });
  await page.goto(authAppURL + '/admin/members');
  await page.getByRole('button', { name: 'Invite member', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Existing school record', { exact: true }).selectOption(id);
  await dialog.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(dialog).toContainText('Page 2 teacher');
  await expect(dialog.getByRole('button', { name: 'Send invitation', exact: true })).toBeDisabled();
  expect(sends).toBe(0);
});
