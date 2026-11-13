import { expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { fixtureToken, test } from './fixtures/platform-app';
import { purgeApprovedSchool } from '../../apps/worker/src/offboarding';

async function mockAuthenticator(
  page: Page,
  id: string,
  factorId: string,
  code: string,
  schoolAdmin = false,
) {
  const user = {
    id,
    email: schoolAdmin ? 'school-admin@example.test' : 'platform@example.test',
    aud: 'authenticated',
    role: 'authenticated',
    factors: [{ id: factorId, status: 'verified', factor_type: 'totp' }],
    app_metadata: {},
    user_metadata: {},
    created_at: '2026-01-01T00:00:00Z',
  };
  const session = {
    user,
    access_token: fixtureToken(id),
    refresh_token: 'isolated-refresh',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  };
  if (schoolAdmin)
    await page.addInitScript((session) => {
      localStorage.setItem('sb-mfa-qr-auth-token', JSON.stringify(session));
    }, session);
  const verifications: string[] = [];
  const challenge = 'test-challenge-' + factorId;
  await page.route('https://mfa-qr.test/auth/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/auth/v1/user') return route.fulfill({ json: user });
    if (path === `/auth/v1/factors/${factorId}/challenge`)
      return route.fulfill({ json: { id: challenge, expires_at: session.expires_at } });
    if (path === `/auth/v1/factors/${factorId}/verify`) {
      expect(route.request().postDataJSON()).toEqual({ code, challenge_id: challenge });
      verifications.push(id);
      return route.fulfill({
        json: {
          ...session,
          access_token: fixtureToken(id, 'aal2', id, Math.floor(Date.now() / 1000)),
        },
      });
    }
    return route.fallback();
  });
  return verifications;
}

test('two admins approve and queue permanent deletion through their own dashboards', async ({
  page,
  browser,
  authAppURL,
  platformApp,
}) => {
  test.setTimeout(90000);
  const { root, db, records } = platformApp;
  const rootCode = '123456',
    schoolCode = '654321';
  const rootChecks = await mockAuthenticator(
    page,
    root,
    await platformApp.enrollAuthenticator(root),
    rootCode,
  );
  const schoolAdmin = randomUUID();
  await db.query(
    "INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,'school-admin@example.test',now())",
    [schoolAdmin],
  );
  await db.query(
    "INSERT INTO school_memberships(school_id,user_id,role_id) SELECT $1,$2,id FROM roles WHERE code='school_admin'",
    [records.schoolA, schoolAdmin],
  );
  platformApp.registerIdentity(schoolAdmin);
  const schoolFactor = await platformApp.enrollAuthenticator(schoolAdmin);
  await page.goto(authAppURL + '/platform/schools');
  const school = page.getByRole('row').filter({ hasText: 'Test School A' });
  await school.getByRole('button', { name: 'Permanently delete school' }).click();
  let dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('This permanently removes the school');
  await dialog.getByLabel('School Admin who will approve').selectOption(schoolAdmin);
  await dialog.getByLabel('Type DELETE').fill('DELETE');
  await dialog.getByLabel('Type the exact school name').fill('Test School B');
  await dialog.getByLabel('Retention policy reference').fill('DELETION-UI-TEST');
  await dialog.getByLabel('Export available until').fill('2099-11-01T12:00');
  await dialog.getByLabel('Earliest permanent deletion').fill('2099-12-01T12:00');
  await dialog.getByLabel('Reason').fill('Verify the isolated permanent deletion approval flow.');
  await dialog.getByLabel('Code from your authenticator').fill(rootCode);
  await dialog.getByRole('button', { name: 'Send approval request' }).click();
  await expect(dialog.getByRole('alert')).toHaveText(
    'Type DELETE and enter the exact school name.',
  );
  expect(rootChecks).toEqual([]);
  await dialog.getByLabel('Type the exact school name').fill('Test School A');
  await dialog.getByRole('button', { name: 'Send approval request' }).click();
  await expect(page).toHaveURL(/\/platform\/offboarding$/);
  const job = page.getByRole('row').filter({ hasText: 'DELETION-UI-TEST' });
  await expect(job.getByRole('button', { name: 'Close school', exact: true })).toBeDisabled();

  const context = await browser.newContext();
  try {
    const admin = await context.newPage();
    const schoolChecks = await mockAuthenticator(
      admin,
      schoolAdmin,
      schoolFactor,
      schoolCode,
      true,
    );
    await admin.route('**/api/v1/**', async (route) => {
      const url = new URL(route.request().url());
      await route.fulfill({
        response: await route.fetch({ url: platformApp.url + url.pathname + url.search }),
      });
    });
    await admin.goto(authAppURL + '/admin/exports');
    const review = admin.getByRole('button', { name: 'Review deletion request' });
    await expect(review).toBeVisible({ timeout: 15000 });
    await review.click();
    const approval = admin.getByRole('dialog');
    await expect(approval).toContainText('Test School A');
    await approval.getByLabel('Your decision').selectOption('approve');
    await approval.getByLabel('Code from your authenticator').fill(schoolCode);
    await approval.getByRole('button', { name: 'Record decision' }).click();
    await expect(admin.getByRole('status').filter({ hasText: 'Deletion approved' })).toBeVisible();
    expect(schoolChecks).toEqual([schoolAdmin]);
  } finally {
    await context.close();
  }

  await db.query('UPDATE devices SET last_seen_at=now() WHERE school_id=$1', [records.schoolA]);
  await page.reload();
  await job.getByRole('button', { name: 'Close school', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Code from your authenticator').fill(rootCode);
  await dialog.getByRole('button', { name: 'Close school', exact: true }).click();
  await expect(job).toContainText('Awaiting final school export');
  await expect(job.getByRole('button', { name: 'Review permanent deletion' })).toBeDisabled();

  // Advance the disposable fixture's retention clock and record its completed export.
  await db.query(
    "UPDATE school_offboarding SET export_until=now()-interval '2 days',delete_after=now()-interval '1 day' WHERE school_id=$1",
    [records.schoolA],
  );
  await db.query(
    "INSERT INTO school_exports(school_id,requested_by,format,status,snapshot_at,completed_at) VALUES($1,$2,'JSON','COMPLETED',now(),now())",
    [records.schoolA, records.admin],
  );
  await job.getByRole('button', { name: 'Legal hold' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Legal hold').selectOption('false');
  await dialog.getByLabel('Reason').fill('The isolated retention period has elapsed.');
  await dialog.getByLabel('Code from your authenticator').fill(rootCode);
  await dialog.getByRole('button', { name: 'Save legal hold' }).click();
  await job.getByRole('button', { name: 'Review permanent deletion' }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Deletion becomes irreversible');
  await dialog.getByLabel('Type DELETE').fill('DELETE');
  await dialog.getByLabel('Type the exact school name').fill('Test School A');
  await dialog.getByLabel('Code from your authenticator').fill(rootCode);
  await dialog.getByRole('button', { name: 'Permanently delete school' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Permanent deletion queued' }),
  ).toBeVisible();
  expect(rootChecks).toEqual([root, root, root, root]);
});

test('a shared user with a stale school selection recovers into their remaining workspace', async ({
  browser,
  authAppURL,
  platformApp,
}) => {
  test.setTimeout(60000);
  const { db, records, root, pools, storage } = platformApp;
  const target = randomUUID();
  await db.query(
    "INSERT INTO schools(id,school_code,name,status) VALUES($1,'ERASURE-WORKSPACE','Deleted workspace fixture','SUSPENDED')",
    [target],
  );
  await db.query(
    "INSERT INTO school_memberships(school_id,user_id,role_id) SELECT $1,$2,id FROM roles WHERE code='teacher'",
    [target, records.teacher],
  );
  await db.query(
    `INSERT INTO school_offboarding(school_id,requested_by,policy_ref,reason,export_until,delete_after,
      status,legal_hold,school_approved_by,closed_by,closed_at,purge_requested_by,permanent,
      approval_recipient,approval_expires_at,approved_at,purge_requested_at)
     VALUES($1,$2,'STALE-TEST','Isolated workspace recovery',now()-interval '2 days',now()-interval '1 day',
      'PURGE_REQUESTED',false,$3,$2,now()-interval '3 days',$2,true,$3,
      now()-interval '3 days',now()-interval '4 days',now())`,
    [target, root, records.admin],
  );
  await db.query(
    "INSERT INTO school_exports(school_id,requested_by,format,status,snapshot_at,completed_at) VALUES($1,$2,'JSON','COMPLETED',now(),now())",
    [target, records.admin],
  );
  await purgeApprovedSchool(pools.worker, target, storage);
  expect((await db.query('SELECT id FROM schools WHERE id=$1', [target])).rows).toEqual([]);

  const context = await browser.newContext({ reducedMotion: 'reduce' });
  try {
    const page = await context.newPage();
    const id = records.teacher;
    await page.addInitScript(
      ({ target, id, token }) => {
        sessionStorage.setItem('vidyalayaa.identity', id);
        sessionStorage.setItem('vidyalayaa.school', target);
        localStorage.setItem(
          'sb-mfa-qr-auth-token',
          JSON.stringify({
            access_token: token,
            refresh_token: 'fixture-refresh',
            token_type: 'bearer',
            expires_in: 3600,
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            user: { id },
          }),
        );
      },
      { target, id, token: fixtureToken(id) },
    );
    await page.route('**/api/v1/**', async (route) => {
      const url = new URL(route.request().url());
      await route.fulfill({
        response: await route.fetch({ url: platformApp.url + url.pathname + url.search }),
      });
    });
    await page.goto(authAppURL + '/teacher/r/assignments');
    await expect(page).toHaveURL(/\/teacher\/?$/);
    await expect(page.getByRole('banner')).toContainText('Test School A');
    await expect(page.getByRole('link', { name: 'Overview' })).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem('vidyalayaa.school'))).toBe('');
  } finally {
    await context.close();
  }
});
