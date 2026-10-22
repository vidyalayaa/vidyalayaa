import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import { test } from './fixtures/principal-app';
import { fixtureToken } from './fixtures/platform-app';
import { sampleRule } from '../../apps/web/src/features/resources/metadata';
import { generateReports } from '../../apps/worker/src/reports';
import AxeBuilder from '@axe-core/playwright';

async function fill(page: Page, values: Record<string, unknown>) {
  const dialog = page.getByRole('dialog').last();
  for (const [key, value] of Object.entries(values)) {
    const control = dialog.locator(`[id="${key}"]`);
    if ((await control.evaluate((e) => e.tagName)) === 'SELECT')
      await control.selectOption(String(value));
    else await control.fill(String(value));
  }
}
async function save(page: Page, name = 'Save') {
  await page.getByRole('dialog').last().getByRole('button', { name, exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test('Principal dashboard, school-wide analytics and permitted navigation work', async ({
  page,
  authAppURL,
  platformApp,
  isMobile,
}) => {
  const f = platformApp.records;
  const dashboard = await platformApp.request(
    '/dashboard',
    'GET',
    undefined,
    f.principal,
    f.schoolA,
  );
  expect(dashboard.status).toBe(200);
  expect(dashboard.body.stats.students).toBeGreaterThanOrEqual(1);
  expect(dashboard.body.deviceHealth.total).toBe(2);
  expect(
    (await platformApp.request('/analytics', 'GET', undefined, f.principal, f.schoolA)).status,
  ).toBe(200);
  await page.goto(authAppURL + '/principal');
  await expect(page.getByText('Leadership Quick Actions', { exact: true })).toBeVisible();
  await expect(page.getByText('Total students', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Class Register', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Issue NFC Card', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'Fee Desk', exact: true }).click();
  await expect(page).toHaveURL(/\/principal\/r\/fee_records$/);
  if (isMobile) await page.getByRole('button', { name: 'Open navigation' }).click();
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  for (const name of [
    'Students',
    'Parents',
    'Attendance',
    'Academics',
    'Results',
    'Reports',
    'Announcements',
  ])
    await expect(nav.getByRole('link', { name, exact: true })).toBeVisible();
  for (const name of ['Members & invitations', 'Platform console', 'School exports'])
    await expect(nav.getByRole('link', { name, exact: true })).toHaveCount(0);
});

for (const resource of [
  'students',
  'parents',
  'teachers',
  'academic_sessions',
  'classes',
  'subjects',
  'enrollments',
  'student_parents',
  'teacher_class_assignments',
  'exams',
  'marks',
  'assignments',
  'timetable_entries',
  'fee_records',
  'nfc_cards',
  'device_locations',
  'attendance_rule_versions',
]) {
  test(`Principal reads ${resource} and cannot change records`, async ({
    page,
    authAppURL,
    platformApp,
  }) => {
    const f = platformApp.records;
    const admin = (path: string, method = 'GET', body?: unknown) =>
      platformApp.request(path, method, body, f.admin, f.schoolA);
    const suffix = randomUUID().slice(0, 8);
    const staff = (await admin('/resources/teachers')).body.data[0];
    const inputs: Record<string, unknown> = {
      exams: {
        class_id: f.classId,
        name: 'Principal exam ' + suffix,
        exam_type: 'UNIT',
        max_score: 100,
        status: 'OPEN',
      },
      assignments: {
        kind: 'HOMEWORK',
        class_id: f.classId,
        title: 'Principal homework ' + suffix,
        body: 'Read and explain all steps.',
      },
      timetable_entries: {
        class_id: f.classId,
        subject_id: f.subject,
        teacher_id: staff.id,
        weekday: 2,
        starts_at: '10:00',
        ends_at: '10:45',
        room: 'Principal review',
      },
      school_holidays: {
        kind: 'HOLIDAY',
        on_date: '2027-03-15',
        label: 'Principal calendar review',
      },
      fee_records: {
        student_id: f.student,
        academic_session_id: f.session,
        fee_type: 'Principal fee ' + suffix,
        amount_due: 100,
        due_on: '2026-10-21',
      },
      attendance_rule_versions: {
        version_no: 1,
        effective_from: '2026-01-01',
        day_type: 'REGULAR',
        rules: sampleRule,
      },
    };
    if (resource === 'marks') {
      const exam = await admin('/resources/exams', 'POST', inputs.exams);
      expect(exam.status).toBe(201);
      inputs.marks = {
        exam_id: exam.body.id,
        student_id: f.student,
        subject_id: f.subject,
        score: 86,
        remarks: 'Principal result review',
      };
    }
    let records = await platformApp.request(
      '/resources/' + resource,
      'GET',
      undefined,
      f.principal,
      f.schoolA,
    );
    if (!records.body.data?.length && inputs[resource]) {
      const created = await admin('/resources/' + resource, 'POST', inputs[resource]);
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      records = await platformApp.request(
        '/resources/' + resource,
        'GET',
        undefined,
        f.principal,
        f.schoolA,
      );
    }
    expect(records.status).toBe(200);
    expect(records.body.data.length).toBeGreaterThan(0);
    const first = records.body.data[0];
    await page.goto(authAppURL + '/principal/r/' + resource);
    const button = page
      .getByRole('button', { name: resource === 'students' ? 'Profile' : 'View', exact: true })
      .first();
    await expect(button).toBeVisible();
    for (const action of [
      'Add student',
      'Add record',
      'Edit',
      'Archive',
      'Import CSV',
      'Pay',
      'Remind',
      'Issue Card',
      'Block',
    ])
      await expect(page.getByRole('button', { name: action, exact: true })).toHaveCount(0);
    await button.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(
      page.getByRole('dialog').getByRole('status', { name: 'Loading records' }),
    ).toHaveCount(0);
    await expect(page.getByRole('dialog').getByRole('alert')).toHaveCount(0);
    const detail = await platformApp.request(
      `/resources/${resource}/${first.id}`,
      'GET',
      undefined,
      f.principal,
      f.schoolA,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.id).toBe(first.id);
    for (const [path, method, body] of [
      ['/resources/' + resource, 'POST', {}],
      [`/resources/${resource}/${first.id}`, 'PATCH', {}],
      [
        `/resources/${resource}/${first.id}/retire`,
        'POST',
        { reason: 'Principal must not retire this' },
      ],
    ] as const) {
      const denied = await platformApp.request(path, method, body, f.principal, f.schoolA);
      // Immutable and non-retirable resources may reject the operation before the role check.
      expect(path.endsWith('/retire') ? [403, 404, 405, 422] : [403, 405]).toContain(denied.status);
    }
  });
}

test('Principal views the school calendar with no event-management actions', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  const f = platformApp.records;
  const r = await platformApp.request(
    '/calendar/events',
    'POST',
    {
      title: 'Principal calendar inspection',
      description: 'Read-only calendar details',
      kind: 'SCHOOL_EVENT',
      start_date: '2027-03-15',
      end_date: '2027-03-16',
      audience: 'SCHOOL',
      class_ids: [],
    },
    f.admin,
    f.schoolA,
  );
  expect(r.status).toBe(201);
  await page.goto(authAppURL + '/principal/r/school_holidays');
  await expect(page).toHaveURL(/\/principal\/calendar$/);
  await page.getByLabel('Calendar year', { exact: true }).selectOption('2027');
  await page.locator('[data-date="2027-03-15"]').click();
  await expect(page.getByRole('dialog')).toContainText('Principal calendar inspection');
  for (const action of ['Add event', 'Edit event', 'Delete event'])
    await expect(page.getByRole('button', { name: new RegExp('^' + action) })).toHaveCount(0);
  expect(
    (
      await platformApp.request(
        '/calendar/events/' + r.body.id,
        'PATCH',
        { expected_version: r.body.version },
        f.principal,
        f.schoolA,
      )
    ).status,
  ).toBe(403);
});

test('Principal reviews all student profile sections without administration controls', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  const f = platformApp.records;
  const admin = (path: string, body: unknown) =>
    platformApp.request(path, 'POST', body, f.admin, f.schoolA);
  const exam = await admin('/resources/exams', {
    class_id: f.classId,
    name: 'Principal profile assessment ' + randomUUID().slice(0, 8),
    exam_type: 'UNIT',
    max_score: 100,
    status: 'OPEN',
  });
  expect(exam.status).toBe(201);
  expect(
    (
      await admin('/resources/marks', {
        student_id: f.student,
        exam_id: exam.body.id,
        subject_id: f.subject,
        score: 83,
        remarks: 'Principal profile academic record',
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await admin('/resources/fee_records', {
        student_id: f.student,
        academic_session_id: f.session,
        fee_type: 'Principal profile fee record',
        amount_due: 100,
        due_on: '2026-10-18',
      })
    ).status,
  ).toBe(201);
  await page.goto(authAppURL + '/principal/r/students');
  await page
    .getByRole('row')
    .filter({ hasText: 'STU001' })
    .getByRole('button', { name: 'Profile', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Parent Test');
  await expect(dialog).toContainText('AABBCCDD');
  for (const name of [
    'Attendance Record',
    'Academic Results',
    'Fees & Billing',
    'Overview & Guardians',
  ]) {
    await dialog.getByRole('button', { name, exact: true }).click();
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    if (name === 'Academic Results' || name === 'Fees & Billing') {
      expect(await dialog.locator('table').count()).toBeGreaterThan(0);
      for (const table of await dialog.locator('table').all()) {
        expect(
          await table.evaluate((element) => {
            const parent = element.parentElement!;
            return (
              element.scrollWidth <= parent.clientWidth ||
              ['auto', 'scroll'].includes(getComputedStyle(parent).overflowX)
            );
          }),
        ).toBe(true);
      }
    }
  }
  expect(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
  for (const name of ['Mark Attendance', 'Replace NFC Card', 'Link Parent', 'Record payment'])
    await expect(dialog.getByRole('button', { name, exact: true })).toHaveCount(0);
});

test('Principal creates, edits and reads school and class announcements', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  const f = platformApp.records;
  for (const audience of ['SCHOOL', 'CLASS', 'PARENTS', 'STAFF']) {
    const title = 'Principal ' + audience + ' ' + randomUUID().slice(0, 8);
    await page.goto(authAppURL + '/principal/r/announcements');
    await page.getByRole('button', { name: 'Add record', exact: true }).click();
    await fill(page, {
      audience,
      title,
      body: 'Principal announcement full message.',
      ...(audience === 'CLASS' ? { class_id: f.classId } : {}),
      published_at: '2026-01-01T10:00',
    });
    await save(page, 'Save record');
    const row = page.getByRole('row').filter({ hasText: title });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Edit ' + title, exact: true }).click();
    await fill(page, { body: 'Updated principal announcement full message.' });
    await save(page, 'Save record');
    await row.getByRole('button', { name: 'View', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText(
      'Updated principal announcement full message.',
    );
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    const list = await platformApp.request(
      '/resources/announcements?search=' + encodeURIComponent(title),
      'GET',
      undefined,
      f.principal,
      f.schoolA,
    );
    expect(list.body.data[0].body).toBe('Updated principal announcement full message.');
  }
});

test('Principal requests corrections, cannot self-approve, and approves or rejects other requests', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  const f = platformApp.records;
  const seeded = await platformApp.request(
    '/attendance/manual',
    'POST',
    {
      student_id: f.student,
      date: '2026-10-20',
      status: 'ABSENT',
      reason: 'Generated principal review attendance',
    },
    f.admin,
    f.schoolA,
  );
  expect(seeded.status, JSON.stringify(seeded.body)).toBe(200);
  await page.goto(authAppURL + '/principal/attendance');
  await expect(page.getByRole('button', { name: 'Class Register', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Mark attendance', exact: true })).toBeDisabled();
  await page.getByLabel('Attendance date', { exact: true }).fill('2026-10-20');
  await page
    .getByRole('row')
    .filter({ hasText: 'STU001' })
    .getByRole('button', { name: 'Request correction' })
    .click();
  const reason = 'Principal correction ' + randomUUID().slice(0, 8);
  await fill(page, { 'action-requested_status': 'EXCUSED', 'action-reason': reason });
  await save(page);
  await page.goto(authAppURL + '/principal/corrections');
  const own = page.locator('.review-row').filter({ hasText: reason });
  await expect(own).toContainText('Another approver');
  await expect(own.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  const ownId = (
    await platformApp.request('/corrections', 'GET', undefined, f.principal, f.schoolA)
  ).body.data.find((r: any) => r.reason === reason).id;
  expect(
    (
      await platformApp.request(
        '/corrections/' + ownId + '/decision',
        'POST',
        { approve: true },
        f.principal,
        f.schoolA,
      )
    ).status,
  ).toBe(403);
  for (const approve of [true, false]) {
    const reason = `Teacher principal review ${approve} ` + randomUUID().slice(0, 8);
    const request = await platformApp.request(
      '/corrections',
      'POST',
      { daily_attendance_id: seeded.body.id, requested_status: 'PRESENT', reason },
      f.teacher,
      f.schoolA,
    );
    expect(request.status).toBe(201);
    await page.reload();
    const row = page.locator('.review-row').filter({ hasText: reason });
    await row.getByRole('button', { name: approve ? 'Approve' : 'Reject', exact: true }).click();
    await expect(row).toContainText(approve ? /APPLIED/i : /REJECTED/i);
  }
  const day = await platformApp.request(
    '/attendance?date=2026-10-20',
    'GET',
    undefined,
    f.principal,
    f.schoolA,
  );
  expect(day.body.data[0].attendance_status).toBe('PRESENT');
});

test('Principal dashboard counts pending corrections beyond the first page and excludes own requests', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  const f = platformApp.records;
  const day = await platformApp.request(
    '/attendance/manual',
    'POST',
    {
      student_id: f.student,
      date: '2026-10-19',
      status: 'ABSENT',
      reason: 'Generated pending review fixture',
    },
    f.admin,
    f.schoolA,
  );
  expect(day.status).toBe(200);
  for (let i = 0; i < 12; i++) {
    const created = await platformApp.request(
      '/corrections',
      'POST',
      {
        daily_attendance_id: day.body.id,
        requested_status: 'EXCUSED',
        reason: 'Pending older principal review ' + i,
      },
      f.teacher,
      f.schoolA,
    );
    expect(created.status).toBe(201);
  }
  for (let i = 0; i < 10; i++) {
    const created = await platformApp.request(
      '/corrections',
      'POST',
      {
        daily_attendance_id: day.body.id,
        requested_status: 'EXCUSED',
        reason: 'Already decided newer review ' + i,
      },
      f.teacher,
      f.schoolA,
    );
    expect(created.status).toBe(201);
    expect(
      (
        await platformApp.request(
          '/corrections/' + created.body.id + '/decision',
          'POST',
          { approve: false },
          f.admin,
          f.schoolA,
        )
      ).status,
    ).toBe(200);
  }
  const all = await platformApp.request(
    '/corrections?page_size=100',
    'GET',
    undefined,
    f.principal,
    f.schoolA,
  );
  const expected = all.body.data.filter(
    (r: any) => r.status === 'REQUESTED' && r.requested_by !== f.principal,
  ).length;
  await page.goto(authAppURL + '/principal');
  const banner = page.getByText('Action Required by School Leadership').locator('..');
  await expect(banner).toContainText(`${expected} attendance corrections awaiting review`);
  await page.getByRole('link', { name: 'Review Corrections', exact: true }).click();
  await expect(page).toHaveURL(/\/principal\/corrections\?status=REQUESTED&reviewable=1$/);
  await expect(page.getByLabel('Correction status', { exact: true })).toHaveValue('REQUESTED');
  await expect(page.getByLabel('Requests from other people')).toBeChecked();
  await expect(page.getByRole('main')).not.toContainText('Already decided newer review');
  await page.getByLabel('Correction status', { exact: true }).selectOption('REJECTED');
  await expect(page.getByRole('main')).toContainText('Already decided newer review');
});

test('Principal reads device health and configuration history without write controls', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  const f = platformApp.records;
  const device = (
    await platformApp.request('/devices', 'GET', undefined, f.admin, f.schoolA)
  ).body.data.find((d: any) => d.id === f.deviceA);
  expect(
    (
      await platformApp.request(
        '/devices/' + f.deviceA,
        'PATCH',
        {
          name: device.name,
          location_id: device.location_id,
          status: 'ACTIVE',
          reason: 'Principal read-only history verification',
          config: { heartbeat_interval_s: 90 },
        },
        f.admin,
        f.schoolA,
      )
    ).status,
  ).toBe(200);
  const history = await platformApp.request(
    '/devices/' + f.deviceA + '/configurations',
    'GET',
    undefined,
    f.principal,
    f.schoolA,
  );
  expect(history.status).toBe(200);
  await page.goto(authAppURL + '/principal/devices');
  await expect(page.locator('.device-card')).toHaveCount(2);
  await expect(page.getByRole('button', { name: /Claim/ })).toBeDisabled();
  for (const button of await page.getByRole('button', { name: /Manage device/ }).all())
    await expect(button).toBeDisabled();
  await page
    .locator('.device-card')
    .filter({ hasText: String(device.device_code) })
    .getByRole('button', { name: 'Reader settings & history', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toContainText('Read-only reader configuration');
  await expect(page.getByRole('dialog').getByLabel('Heartbeat Interval S')).toBeDisabled();
  await expect(page.getByRole('dialog').getByLabel('Heartbeat Interval S')).toHaveValue('90');
  await expect(page.getByRole('dialog')).toContainText('Principal read-only history verification');
  await expect(page.getByRole('button', { name: 'Save reader settings', exact: true })).toHaveCount(
    0,
  );
});

test('Principal reads notifications and requests event reconciliation', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  const f = platformApp.records;
  await page.goto(authAppURL + '/principal/notifications');
  await expect(
    page.locator('.review-row').filter({ hasText: 'Generated failed delivery' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry delivery', exact: true })).toHaveCount(0);
  await page.goto(authAppURL + '/principal/attendance/history');
  await page.getByLabel('Needs review').check();
  await page.getByRole('button', { name: 'Request reconciliation', exact: true }).click();
  await fill(page, { 'action-reason': 'Principal review of isolated device clock evidence' });
  await save(page);
  await expect(
    page.getByRole('row').filter({ hasText: 'Principal review of isolated device clock evidence' }),
  ).toBeVisible();
  expect(
    (await platformApp.request('/attendance/reviews', 'GET', undefined, f.principal, f.schoolA))
      .status,
  ).toBe(200);
});

for (const kind of ['ATTENDANCE', 'ACADEMIC', 'FEES']) {
  for (const format of ['PDF', 'CSV']) {
    test(`Principal generates and downloads ${kind} ${format} reports`, async ({
      page,
      authAppURL,
      platformApp,
    }) => {
      const f = platformApp.records;
      const admin = (path: string, body: unknown) =>
        platformApp.request(path, 'POST', body, f.admin, f.schoolA);
      if (kind === 'ATTENDANCE') {
        const attendance = await admin('/attendance/manual', {
          student_id: f.student,
          date: '2026-10-18',
          status: 'PRESENT',
          reason: 'Generated Principal report attendance',
        });
        expect(attendance.status, JSON.stringify(attendance.body)).toBe(200);
      } else if (kind === 'ACADEMIC') {
        const exam = await admin('/resources/exams', {
          class_id: f.classId,
          name: 'Principal report assessment ' + randomUUID().slice(0, 8),
          exam_type: 'UNIT',
          max_score: 100,
          starts_on: '2026-10-18',
          status: 'OPEN',
        });
        expect(exam.status).toBe(201);
        expect(
          (
            await admin('/resources/marks', {
              student_id: f.student,
              exam_id: exam.body.id,
              subject_id: f.subject,
              score: 88,
            })
          ).status,
        ).toBe(201);
      } else {
        expect(
          (
            await admin('/resources/fee_records', {
              student_id: f.student,
              academic_session_id: f.session,
              fee_type: 'Principal report fee ' + randomUUID().slice(0, 8),
              amount_due: 123,
              due_on: '2026-10-18',
            })
          ).status,
        ).toBe(201);
      }
      await page.goto(authAppURL + '/principal/reports');
      await page.getByRole('button', { name: 'Create report', exact: true }).first().click();
      await fill(page, {
        'action-kind': kind,
        'action-format': format,
        'action-from': '2026-10-01',
        'action-to': '2026-10-21',
      });
      await save(page);
      await generateReports(platformApp.pools.worker, f.schoolA, platformApp.storage);
      await page.reload();
      const row = page
        .locator('.review-row')
        .filter({ hasText: kind + ' report' })
        .filter({ has: page.getByRole('button', { name: 'Download ' + format, exact: true }) })
        .first();
      await expect(row).toContainText(/COMPLETED/i);
      const event = page.waitForEvent('download');
      await row.getByRole('button', { name: 'Download ' + format, exact: true }).click();
      const download = await event;
      expect(download.suggestedFilename()).toBe('vidyalayaa-report.' + format.toLowerCase());
      const stream = await download.createReadStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString();
      expect(body).not.toContain('Foreign learner');
      if (format === 'CSV') expect(body).toContain('STU001');
      if (format === 'PDF') expect(body.startsWith('%PDF')).toBe(true);
      else
        expect(body).toContain(
          kind === 'ATTENDANCE' ? 'attendance_date' : kind === 'FEES' ? 'fee_type' : 'score',
        );
      const reports = await platformApp.request(
        '/reports',
        'GET',
        undefined,
        f.principal,
        f.schoolA,
      );
      expect(reports.status).toBe(200);
      expect(
        (
          await platformApp.request(
            '/reports/' + reports.body.data[0].id + '/download',
            'GET',
            undefined,
            f.admin,
            f.schoolA,
          )
        ).status,
      ).toBe(404);
    });
  }
}

test('Principal settings show plan and account security without school administration', async ({
  page,
  authAppURL,
}) => {
  await page.goto(authAppURL + '/principal/settings');
  await expect(page.getByRole('heading', { name: 'Account security', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your school plan', exact: true })).toBeVisible();
  await expect(page.getByText('Professional', { exact: true })).toBeVisible();
  await expect(page.getByRole('main')).toContainText('School timezone');
  await expect(page.getByRole('main')).toContainText('Asia/Kolkata');
  for (const name of ['Manage members', 'Audit history', 'Support access'])
    await expect(page.getByRole('link', { name, exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Set approved retention policy', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Enable browser notifications', exact: true }),
  ).toHaveCount(0);
});

test('Principal cannot use another role portal or school administration pages', async ({
  page,
  authAppURL,
}) => {
  for (const path of [
    '/admin',
    '/platform',
    '/teacher',
    '/parent',
    '/student',
    '/principal/members',
    '/principal/audit',
    '/principal/support',
    '/principal/exports',
  ]) {
    await page.goto(authAppURL + path);
    await expect(
      page.getByRole('heading', { name: 'Access unavailable', exact: true }),
    ).toBeVisible();
  }
});

test('Principal API enforces school isolation and rejects privileged operations', async ({
  platformApp,
}) => {
  const f = platformApp.records;
  const call = (path: string, method = 'GET', body?: unknown) =>
    platformApp.request(path, method, body, f.principal, f.schoolA);
  for (const path of [
    '/resources/students/' + f.foreignStudent,
    '/students/' + f.foreignStudent + '/overview',
  ])
    expect((await call(path)).status).toBe(404);
  expect(
    (await platformApp.request('/resources/students', 'GET', undefined, f.principal, f.schoolB))
      .status,
  ).toBe(404);
  for (const [path, method] of [
    ['/memberships', 'GET'],
    ['/invitations', 'POST'],
    ['/audit', 'GET'],
    ['/support-grants', 'GET'],
    ['/exports', 'POST'],
    ['/school', 'PATCH'],
    ['/school/security', 'PUT'],
    ['/school/retention', 'PUT'],
    ['/attendance/manual', 'POST'],
    ['/attendance/bulk', 'POST'],
    ['/cards/issue', 'POST'],
    ['/cards/' + randomUUID() + '/block', 'POST'],
    ['/fees/' + randomUUID() + '/pay', 'POST'],
    ['/fees/' + randomUUID() + '/remind', 'POST'],
    ['/devices/claim', 'POST'],
    ['/devices/' + f.deviceA, 'PATCH'],
    ['/notifications/' + randomUUID() + '/retry', 'POST'],
    ['/platform/schools', 'GET'],
  ])
    expect(
      (await call(path, method, method === 'GET' ? undefined : {})).status,
      `${method} ${path}`,
    ).toBe(403);
  const spoof = await fetch(platformApp.url + '/api/v1/resources/students', {
    headers: {
      Authorization: 'Bearer ' + fixtureToken(f.principal),
      'X-School-Id': f.schoolB,
      'X-Role': 'school_admin',
    },
  });
  expect(spoof.status).toBe(404);
});

test('Principal downloads private school study materials but cannot upload them', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  const f = platformApp.records;
  const filename = 'principal-material.pdf';
  const ticket = await platformApp.request(
    '/materials/upload',
    'POST',
    { class_id: f.classId, filename },
    f.admin,
    f.schoolA,
  );
  expect(ticket.status).toBe(200);
  const bytes = Buffer.from('%PDF-1.4\nPrivate Principal material verification\n%%EOF');
  platformApp.objects.set(ticket.body.path, bytes);
  const assignment = await platformApp.request(
    '/resources/assignments',
    'POST',
    {
      class_id: f.classId,
      kind: 'MATERIAL',
      title: 'Private Principal review material',
      storage_path: ticket.body.path,
    },
    f.admin,
    f.schoolA,
  );
  expect(assignment.status).toBe(201);
  await page.goto(authAppURL + '/principal/r/assignments');
  await page
    .getByRole('row')
    .filter({ hasText: 'Private Principal review material' })
    .getByRole('button', { name: 'View', exact: true })
    .click();
  const event = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download material', exact: true }).click();
  const download = await event;
  expect(download.suggestedFilename()).toContain(filename);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
  expect(
    (
      await platformApp.request(
        '/materials/upload',
        'POST',
        { class_id: f.classId, filename },
        f.principal,
        f.schoolA,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await platformApp.request(
        '/materials/' + f.foreignStudent + '/download',
        'GET',
        undefined,
        f.principal,
        f.schoolA,
      )
    ).status,
  ).toBe(404);
});

test('Principal sees published results from another class without a teaching assignment', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  const f = platformApp.records;
  const admin = (path: string, method = 'GET', body?: unknown) =>
    platformApp.request(path, method, body, f.admin, f.schoolA);
  const suffix = randomUUID().slice(0, 8);
  const classRecord = await admin('/resources/classes', 'POST', {
    academic_session_id: f.session,
    grade: '9',
    section: suffix,
    class_teacher_id: f.teacherId,
  });
  expect(classRecord.status).toBe(201);
  const student = await admin('/resources/students', 'POST', {
    student_code: 'PRINCIPAL_' + suffix,
    first_name: 'Another class learner',
  });
  expect(student.status).toBe(201);
  expect(
    (
      await admin('/resources/enrollments', 'POST', {
        student_id: student.body.id,
        class_id: classRecord.body.id,
        academic_session_id: f.session,
        starts_on: '2026-01-01',
      })
    ).status,
  ).toBe(201);
  const exam = await admin('/resources/exams', 'POST', {
    class_id: classRecord.body.id,
    name: 'Principal analytics ' + suffix,
    exam_type: 'UNIT',
    max_score: 100,
    status: 'OPEN',
  });
  expect(exam.status).toBe(201);
  expect(
    (
      await admin('/resources/marks', 'POST', {
        exam_id: exam.body.id,
        student_id: student.body.id,
        subject_id: f.subject,
        score: 91,
      })
    ).status,
  ).toBe(201);
  expect(
    (await admin('/resources/exams/' + exam.body.id, 'PATCH', { status: 'PUBLISHED' })).status,
  ).toBe(200);
  await page.goto(authAppURL + '/principal');
  const analytics = page.getByRole('row').filter({ hasText: suffix });
  await expect(analytics).toContainText('Mathematics');
  await expect(analytics).toContainText('91.00');
  await page.getByRole('link', { name: 'View attendance', exact: true }).click();
  await expect(page).toHaveURL(/\/principal\/attendance$/);
  await page.getByLabel('Class', { exact: true }).selectOption(classRecord.body.id);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('Principal searches students, pages results, and resets filters', async ({
  page,
  authAppURL,
  platformApp,
  isMobile,
}) => {
  test.setTimeout(60000);
  const f = platformApp.records,
    prefix = 'SEARCH_' + randomUUID().slice(0, 5);
  const rows = Array.from({ length: 52 }, (_, i) => ({
    student_code: prefix + '_' + i.toString().padStart(3, '0'),
    first_name: 'Principal search learner ' + i,
  }));
  const response = await fetch(platformApp.url + '/api/v1/imports/students', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + fixtureToken(f.admin),
      'X-School-Id': f.schoolA,
      'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(),
    },
    body: JSON.stringify({ rows, validate_only: false }),
  });
  expect(response.status, await response.text()).toBe(201);
  await page.goto(authAppURL + '/principal/r/students');
  if (!isMobile) {
    await page.locator('.global-search input').fill(prefix + '_051');
    await page.locator('.global-search input').press('Enter');
    await expect(page.getByRole('row').filter({ hasText: prefix + '_051' })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: prefix + '_050' })).toHaveCount(0);
  }
  const search = page
    .getByRole('main')
    .getByRole('textbox', { name: 'Search Students', exact: true });
  await search.fill(prefix);
  await expect(page.locator('.pagination')).toContainText('52 records');
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.locator('.pagination')).toContainText('Page 2');
  await page.getByRole('button', { name: 'Reset filters', exact: true }).click();
  await expect(search).toHaveValue('');
  await expect(page.locator('.pagination')).toContainText('Page 1');
});

test('Principal drafts, schedules and archives announcements without publishing early', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  const f = platformApp.records;
  const title = 'Principal scheduled notice ' + randomUUID().slice(0, 8);
  const read = () =>
    platformApp.request(
      '/resources/announcements?search=' + encodeURIComponent(title),
      'GET',
      undefined,
      f.principal,
      f.schoolA,
    );
  await page.goto(authAppURL + '/principal/r/announcements');
  await page.getByRole('button', { name: 'Add record', exact: true }).click();
  await fill(page, { audience: 'SCHOOL', title, body: 'A future Principal school publication.' });
  await save(page, 'Save record');
  expect((await read()).body.data[0].published_at).toBeNull();
  await page.goto(authAppURL + '/principal');
  await expect(page.getByRole('main')).not.toContainText(title);
  await page.goto(authAppURL + '/principal/r/announcements');
  const row = page.getByRole('row').filter({ hasText: title });
  await row.getByRole('button', { name: 'Edit ' + title, exact: true }).click();
  await fill(page, { published_at: '2099-01-01T10:00' });
  await save(page, 'Save record');
  expect((await read()).body.data[0].published_at).toMatch(/^2099-/);
  expect(
    (
      await platformApp.request(
        '/resources/announcements?search=' + encodeURIComponent(title),
        'GET',
        undefined,
        f.parent,
        f.schoolA,
      )
    ).body.total,
  ).toBe(0);
  await row.getByRole('button', { name: 'Archive', exact: true }).click();
  await fill(page, { 'action-reason': 'Withdraw the generated future Principal publication' });
  await save(page);
  await expect(row).toHaveCount(0);
  expect((await read()).body.total).toBe(0);
});

test('Principal pages have accessible controls and responsive layouts', async ({
  page,
  authAppURL,
}, info) => {
  test.setTimeout(60000);
  for (const path of ['', '/r/students', '/corrections', '/devices', '/reports', '/settings']) {
    await page.goto(authAppURL + '/principal' + path);
    await page.getByRole('heading', { level: 1 }).waitFor();
    await expect(page.getByRole('status', { name: 'Loading records' })).toHaveCount(0);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(
      results.violations.filter((v) => ['serious', 'critical'].includes(v.impact || '')),
    ).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    if (!path)
      await page.screenshot({ path: `tmp/qa/principal-${info.project.name}.png`, fullPage: true });
  }
});
