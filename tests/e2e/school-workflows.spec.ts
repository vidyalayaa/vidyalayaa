import { expect, type Page } from '@playwright/test';
import { test } from './fixtures/auth-app';
const id = '00000000-0000-4000-8000-000000000201',
  school = '00000000-0000-4000-8000-000000000202',
  student = '00000000-0000-4000-8000-000000000203';
async function login(page: Page, role: string, permissions: string[]) {
  const user = {
    id,
    email: 'school-workflow@example.test',
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
      access_token: 'isolated-test-token',
      refresh_token: 'isolated-test-refresh',
      token_type: 'bearer',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      expires_in: 3600,
    },
  );
  await page.route('https://mfa-qr.test/auth/v1/user', (r) => r.fulfill({ json: user }));
  const membership = {
    school_id: school,
    school_name: 'Workflow school',
    timezone: 'Asia/Kolkata',
    role,
    permissions,
  };
  await page.route('**/api/v1/me', (r) =>
    r.fulfill({
      json: {
        ...user,
        full_name: 'School person',
        memberships: [membership],
        school: membership,
        platform_role: null,
        features: { assignments: true },
        limits: {},
      },
    }),
  );
  return user;
}

test('expired sessions restore only the same user’s memory draft after sign-in', async ({
  page,
  authAppURL,
}) => {
  const user = await login(page, 'school_admin', [
    'students.read',
    'students.write',
    'users.manage',
  ]);
  await page.route('**/api/v1/resources/students?**', (r) =>
    r.fulfill({ json: { data: [], total: 0, page: 1, page_size: 25 } }),
  );
  await page.route('**/api/v1/lookups/accounts?**', (r) =>
    r.fulfill({ json: { data: [], total: 0, page: 1, page_size: 100 } }),
  );
  await page.route('**/api/v1/resources/students', (r) =>
    r.fulfill({
      status: 401,
      json: { error: { code: 'UNAUTHENTICATED', message: 'Session expired.' } },
    }),
  );
  await page.route('https://mfa-qr.test/auth/v1/token?**', (r) => {
    if (new URL(r.request().url()).searchParams.get('grant_type') === 'refresh_token')
      return r.fulfill({
        status: 400,
        json: { code: 'refresh_token_not_found', message: 'Fixture refresh expired.' },
      });
    return r.fulfill({
      json: {
        user: { ...user, factors: [] },
        access_token: 'renewed-fixture-token',
        refresh_token: 'renewed-fixture-refresh',
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      },
    });
  });
  await page.route('https://mfa-qr.test/auth/v1/logout?**', (r) => r.fulfill({ status: 204 }));
  await page.goto(`${authAppURL}/admin/r/students`);
  await page.getByRole('button', { name: 'Add student', exact: true }).click();
  await page.getByLabel('Student Code', { exact: true }).fill('DRAFT01');
  await page.getByLabel('First Name', { exact: true }).fill('Recoverable draft');
  page.on('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Save record', exact: true }).click();
  await expect(page).toHaveURL(/\/login\?returnTo=/);
  await page.getByLabel('Email address').fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill('Fixture-only-password-2026');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/r\/students$/);
  await page.getByRole('button', { name: 'Add student', exact: true }).click();
  await expect(page.getByLabel('First Name', { exact: true })).toHaveValue('Recoverable draft');
  expect(
    await page.evaluate(() =>
      Object.keys(sessionStorage).filter((k) => k.startsWith('vidyalayaa.draft.')),
    ),
  ).toEqual([]);
});
test('school record drafts stay in memory and warn before closing', async ({
  page,
  authAppURL,
}) => {
  await login(page, 'school_admin', ['students.read', 'students.write', 'users.manage']);
  await page.route('**/api/v1/resources/students?**', (r) =>
    r.fulfill({ json: { data: [], total: 0, page: 1, page_size: 25 } }),
  );
  await page.route('**/api/v1/lookups/accounts?**', (r) =>
    r.fulfill({ json: { data: [], total: 0, page: 1, page_size: 100 } }),
  );
  await page.goto(`${authAppURL}/admin/r/students`);
  await page.getByRole('button', { name: 'Add student', exact: true }).click();
  await page.getByLabel('First Name', { exact: true }).fill('Private draft fixture');
  page.once('dialog', (d) => d.dismiss());
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Add student', exact: true }).click();
  await expect(page.getByLabel('First Name', { exact: true })).toHaveValue('Private draft fixture');
  expect(
    await page.evaluate(() =>
      Object.keys(sessionStorage).filter((k) => k.startsWith('vidyalayaa.draft.')),
    ),
  ).toEqual([]);
  page.once('dialog', (d) => d.accept());
  await page.reload();
  await page.getByRole('button', { name: 'Add student', exact: true }).click();
  await expect(page.getByLabel('First Name', { exact: true })).toHaveValue('');
});
test('teacher pages attendance and requests a correction from the selected record', async ({
  page,
  authAppURL,
}) => {
  await login(page, 'teacher', [
    'attendance.read',
    'attendance.correct_request',
    'students.read',
    'academics.read',
  ]);
  let requested = false;
  await page.route('**/api/v1/attendance?**', (r) => {
    const second = new URL(r.request().url()).searchParams.get('page') === '2';
    return r.fulfill({
      json: {
        data: [
          {
            id: second ? id : student,
            student_code: second ? 'STU026' : 'STU001',
            first_name: second ? 'Second page learner' : 'First page learner',
            attendance_status: 'ABSENT',
            movement_status: 'NOT_SEEN',
          },
        ],
        total: 26,
        page: second ? 2 : 1,
        page_size: 25,
      },
    });
  });
  await page.route('**/api/v1/resources/classes?**', (r) =>
    r.fulfill({
      json: { data: [{ id, grade: '8', section: 'A' }], total: 1, page: 1, page_size: 100 },
    }),
  );
  await page.route('**/api/v1/corrections', (r) => {
    expect(r.request().postDataJSON()).toEqual({
      daily_attendance_id: id,
      requested_status: 'EXCUSED',
      reason: 'Verified school trip',
    });
    requested = true;
    return r.fulfill({ status: 201, json: { id } });
  });
  await page.goto(`${authAppURL}/attendance`);
  await expect(page).toHaveURL(/\/teacher\/attendance/);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByText('Second page learner')).toBeVisible();
  await page.getByRole('button', { name: 'Request correction', exact: true }).click();
  await expect(page.getByLabel('Daily Attendance')).toHaveCount(0);
  await page.getByLabel('Requested Status').selectOption('EXCUSED');
  await page.getByLabel('Reason').fill('Verified school trip');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(requested).toBe(true);
  await page.goto(`${authAppURL}/admin/attendance`);
  await expect(page.getByRole('heading', { name: 'Access unavailable' })).toBeVisible();
});
test('parent reads full homework, downloads private material and has family navigation', async ({
  page,
  authAppURL,
}, info) => {
  await login(page, 'parent', [
    'assignments.read',
    'students.read',
    'attendance.read',
    'marks.read',
  ]);
  const assignment = {
    id,
    title: 'Fractions practice',
    kind: 'HOMEWORK',
    body: 'Complete questions 1–10 and explain each step.',
    class_label: '8 A',
    storage_path: `${school}/class/material.pdf`,
  };
  await page.route('**/api/v1/resources/assignments?**', (r) =>
    r.fulfill({ json: { data: [assignment], total: 1, page: 1, page_size: 25 } }),
  );
  await page.route(`**/api/v1/resources/assignments/${id}`, (r) => r.fulfill({ json: assignment }));
  await page.route(`**/api/v1/materials/${id}/download`, (r) =>
    r.fulfill({
      json: {
        url: `https://mfa-qr.test/storage/v1/object/sign/school-documents/${school}/class/material.pdf?token=test-only`,
      },
    }),
  );
  await page.route('https://mfa-qr.test/storage/v1/object/sign/**', (r) =>
    r.fulfill({ contentType: 'application/pdf', body: Buffer.from('%PDF-1.4\n%%EOF') }),
  );
  await page.goto(`${authAppURL}/parent/r/assignments`);
  await page.getByRole('button', { name: 'View', exact: true }).click();
  await expect(page.getByText(assignment.body)).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download material' }).click();
  expect((await download).suggestedFilename()).toBe('material.pdf');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  expect(
    await page
      .locator('section.panel')
      .first()
      .evaluate((e) => e.scrollLeft),
  ).toBe(0);
  if (info.project.name === 'mobile')
    await expect(page.getByRole('navigation', { name: 'Family navigation' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `tmp/qa/parent-homework-${info.project.name}.png`,
    fullPage: true,
  });
});
