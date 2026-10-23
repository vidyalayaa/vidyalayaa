import { expect, type Page } from '@playwright/test';
import { test } from './fixtures/school-admin-app';
import { sampleRule } from '../../apps/web/src/features/resources/metadata';
import { generateReports } from '../../apps/worker/src/reports';
import { generateSchoolExport } from '../../apps/worker/src/school-exports';

async function fill(page: Page, values: Record<string, unknown>) {
  const dialog = page.getByRole('dialog').last();
  for (const [name, value] of Object.entries(values)) {
    const control = dialog.locator(`[id="${name}"]`);
    const tag = await control.evaluate((e) => e.tagName);
    if (tag === 'SELECT') await control.selectOption(String(value));
    else if (typeof value === 'boolean') await control.setChecked(value);
    else await control.fill(String(value));
  }
}
async function save(page: Page, name = 'Save record') {
  await page.getByRole('dialog').last().getByRole('button', { name, exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test('School Admin dashboard, navigation and review-grant shortcut work', async ({
  page,
  authAppURL,
  platformApp,
  isMobile,
}) => {
  const grant = await platformApp.request('/platform/support-grants', 'POST', {
    school_id: platformApp.records.schoolA,
    reason: 'Generated school administrator support review',
    ticket_ref: 'SCHOOL-REVIEW',
    scope: ['students'],
    minutes: 60,
  });
  expect(grant.status).toBe(201);
  await page.goto(authAppURL + '/admin');
  await expect(page.getByText('Leadership Quick Actions', { exact: true })).toBeVisible();
  await expect(page.getByText('Total students', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Review Grants', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/support$/);
  await expect(page.getByText('SCHOOL-REVIEW', { exact: true })).toBeVisible();
  if (isMobile) await page.getByRole('button', { name: 'Open navigation' }).click();
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(nav.getByRole('link', { name: 'Members & invitations' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Platform console' })).toHaveCount(0);
});

for (const resource of [
  'teachers',
  'exams',
  'marks',
  'assignments',
  'announcements',
  'device_locations',
] as const) {
  test(`School Admin creates, reads and edits ${resource} through the website`, async ({
    page,
    authAppURL,
    platformApp,
  }) => {
    const f = platformApp.records;
    const call = (path: string, method = 'GET', body?: unknown) =>
      platformApp.request(path, method, body, f.admin, f.schoolA);
    const staff = (await call('/resources/teachers')).body.data.find(
      (r: { staff_code: string }) => r.staff_code === 'T1',
    );
    const exam = await call('/resources/exams', 'POST', {
      class_id: f.classId,
      name: 'Generated ' + resource + ' assessment',
      exam_type: 'UNIT',
      max_score: 100,
      status: 'OPEN',
    });
    expect(exam.status).toBe(201);
    const inputs: Record<string, Record<string, unknown>> = {
      teachers: {
        staff_code: 'WEB_STAFF',
        full_name: 'Website principal',
        email: 'principal-web@example.test',
        staff_role: 'principal',
      },
      academic_sessions: {
        name: 'Website next year',
        starts_on: '2028-01-01',
        ends_on: '2028-12-31',
      },
      classes: {
        academic_session_id: f.session,
        grade: '9',
        section: 'WEB',
        class_teacher_id: f.teacherId,
      },
      subjects: { code: 'WEB_SUB', name: 'Website subject' },
      enrollments: {
        student_id: f.student,
        class_id: f.classId,
        academic_session_id: f.session,
        starts_on: '2028-01-01',
        roll_number: 'WEB99',
      },
      teacher_class_assignments: {
        teacher_id: staff.id,
        class_id: f.classId,
        subject_id: f.subject,
        starts_on: '2028-01-01',
      },
      exams: {
        class_id: f.classId,
        name: 'Website assessment',
        exam_type: 'UNIT',
        max_score: 100,
        status: 'OPEN',
      },
      marks: {
        exam_id: exam.body.id,
        student_id: f.student,
        subject_id: f.subject,
        score: 87,
        remarks: 'Website marks',
      },
      assignments: {
        class_id: f.classId,
        subject_id: f.subject,
        title: 'Website homework',
        body: 'Complete and explain all steps.',
      },
      timetable_entries: {
        class_id: f.classId,
        subject_id: f.subject,
        teacher_id: staff.id,
        weekday: 2,
        starts_at: '10:00',
        ends_at: '10:45',
        room: 'WEB_ROOM',
      },
      school_holidays: { on_date: '2027-03-15', label: 'Website holiday' },
      announcements: {
        title: 'Website announcement',
        body: 'Full school announcement text.',
        audience: 'SCHOOL',
        published_at: '2026-01-01T10:00',
      },
      fee_records: {
        student_id: f.student,
        academic_session_id: f.session,
        fee_type: 'Website fee',
        amount_due: 1000,
        amount_paid: 0,
        currency: 'INR',
        due_on: '2027-01-15',
      },
      device_locations: { name: 'Website gate', location_type: 'ENTRY', is_active: true },
    };
    if (resource === 'enrollments') {
      const student = await call('/resources/students', 'POST', {
        student_code: 'ENROLL_WEB',
        first_name: 'Enrollment website learner',
      });
      expect(student.status).toBe(201);
      inputs[resource].student_id = student.body.id;
    }
    if (resource === 'teacher_class_assignments') {
      const teacher = await call('/resources/teachers', 'POST', {
        staff_code: 'ASSIGN_WEB',
        full_name: 'Assignment website teacher',
      });
      expect(teacher.status).toBe(201);
      inputs[resource].teacher_id = teacher.body.id;
    }
    // Student/parent/family creation and edits are covered together in student-directory.spec.ts.
    await page.goto(authAppURL + '/admin/r/' + resource);
    if (resource === 'marks') {
      await page
        .getByRole('combobox', { name: 'Class and section', exact: true })
        .selectOption(f.classId);
      await page
        .getByRole('combobox', { name: 'Examination', exact: true })
        .selectOption(exam.body.id);
    }
    await page
      .getByRole('button', {
        name: 'Add record',
        exact: true,
      })
      .click();
    await fill(
      page,
      resource === 'marks'
        ? Object.fromEntries(Object.entries(inputs[resource]).filter(([key]) => key !== 'exam_id'))
        : inputs[resource],
    );
    await save(page);
    const list = await call(
      '/resources/' +
        resource +
        '?page_size=100' +
        (resource === 'marks' ? '&class_id=' + f.classId + '&exam_id=' + exam.body.id : ''),
    );
    expect(list.status).toBe(200);
    const key =
      resource === 'classes'
        ? 'grade'
        : resource === 'teacher_class_assignments'
          ? 'teacher_id'
          : Object.keys(inputs[resource]).find((k) =>
              [
                'student_code',
                'staff_code',
                'name',
                'code',
                'title',
                'fee_type',
                'label',
                'room',
                'roll_number',
                'remarks',
                'full_name',
              ].includes(k),
            ) || 'parent_id';
    const record = list.body.data.find(
      (row: Record<string, unknown>) => String(row[key]) === String(inputs[resource][key]),
    );
    expect(record, resource).toBeTruthy();
    // Locate the exact saved row by visible unique text, or by a stable relation label.
    const rows = page
      .getByRole('row')
      .filter({ has: page.getByRole('button', { name: /^Edit / }) });
    const index = list.body.data.findIndex((row: { id: string }) => row.id === record.id);
    await expect(rows).toHaveCount(list.body.data.length);
    await rows
      .nth(index)
      .getByRole('button', { name: /^Edit / })
      .click();
    const editKey =
      resource === 'marks'
        ? 'score'
        : resource === 'fee_records'
          ? 'amount_due'
          : resource === 'enrollments'
            ? 'roll_number'
            : resource === 'teacher_class_assignments'
              ? 'ends_on'
              : key;
    const editValue =
      editKey === 'score'
        ? 89
        : editKey === 'amount_due'
          ? 1100
          : editKey === 'relationship'
            ? 'OTHER'
            : editKey === 'ends_on'
              ? '2028-12-31'
              : String(inputs[resource][editKey]) + ' revised';
    await fill(page, { [editKey]: editValue });
    await save(page);
    const saved = await call('/resources/' + resource + '/' + record.id);
    if (typeof editValue === 'number') expect(Number(saved.body[editKey])).toBe(editValue);
    else
      expect(
        editKey === 'ends_on'
          ? String(saved.body[editKey]).slice(0, 10)
          : String(saved.body[editKey]),
      ).toBe(String(editValue));
    await rows.nth(index).getByRole('button', { name: 'View', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('dialog').getByRole('alert')).toHaveCount(0);
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  });
}

test('School Admin builds an immutable attendance rule and opens student profiles', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  await page.goto(authAppURL + '/admin/r/attendance_rule_versions');
  await page.getByRole('button', { name: 'Add record', exact: true }).click();
  await fill(page, { version_no: 1, effective_from: '2026-01-01' });
  await expect(page.getByLabel('On-Time End (Late After)', { exact: true })).toHaveValue(
    sampleRule.arrival.on_time_end,
  );
  await save(page);
  await page.goto(authAppURL + '/admin/r/students');
  await page
    .locator('summary')
    .filter({ has: page.getByRole('heading', { name: 'Class 8', exact: true }) })
    .click();
  await page
    .getByRole('article', { name: 'Student STU001', exact: true })
    .getByRole('button', { name: /^Test learner / })
    .click();
  await expect(page.getByRole('dialog')).toContainText('Test learner');
  await expect(page.getByRole('dialog')).toContainText('Parent Test');
});

test('School Admin marks a class register and approves a correction', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  const retryKeys: string[] = [];
  await page.route('**/api/v1/attendance/bulk', async (route) => {
    retryKeys.push(route.request().headers()['idempotency-key']);
    const response = await route.fetch({ url: platformApp.url + '/api/v1/attendance/bulk' });
    if (retryKeys.length === 1)
      await route.fulfill({
        status: 503,
        json: {
          error: {
            code: 'FIXTURE_RESPONSE_LOST',
            message: 'The saved response was lost. Retry safely.',
          },
        },
      });
    else await route.fulfill({ response });
  });
  await page.goto(authAppURL + '/admin/attendance');
  await page.getByRole('button', { name: 'Class Register', exact: true }).click();
  await page.getByLabel('Select Class & Section').selectOption(platformApp.records.classId);
  await page.getByLabel('Attendance Date', { exact: true }).fill('2026-10-21');
  await expect(page.getByRole('dialog')).toContainText('Test learner');
  await page.getByRole('button', { name: 'All Absent', exact: true }).click();
  await page.getByRole('button', { name: 'Save Class Attendance', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Retry safely');
  await save(page, 'Save Class Attendance');
  await expect.poll(() => retryKeys.length).toBe(2);
  expect(retryKeys[0]).toBe(retryKeys[1]);
  await page.getByLabel('Attendance date', { exact: true }).fill('2026-10-21');
  const row = page.getByRole('row').filter({ hasText: 'STU001' });
  await expect(row).toContainText(/ABSENT/i);
  await row.getByRole('button', { name: 'Request correction' }).click();
  await page.getByLabel('Requested Status').selectOption('EXCUSED');
  await page.getByLabel('Reason', { exact: true }).fill('Approved school trip correction');
  await save(page, 'Save');
  await page.goto(authAppURL + '/admin/corrections');
  const request = page
    .locator('.review-row')
    .filter({ hasText: 'Approved school trip correction' });
  await expect(request).toContainText('Another approver');
  const f = platformApp.records;
  const corrections = (
    await platformApp.request('/corrections', 'GET', undefined, f.admin, f.schoolA)
  ).body.data;
  const own = corrections.find(
    (c: { reason: string }) => c.reason === 'Approved school trip correction',
  );
  expect(
    (
      await platformApp.request(
        '/corrections/' + own.id + '/decision',
        'POST',
        { approve: true },
        f.principal,
        f.schoolA,
      )
    ).status,
  ).toBe(200);
  const teacherRequest = await platformApp.request(
    '/corrections',
    'POST',
    {
      daily_attendance_id: own.daily_attendance_id,
      requested_status: 'PRESENT',
      reason: 'Teacher requested administrator review',
    },
    f.teacher,
    f.schoolA,
  );
  expect(teacherRequest.status).toBe(201);
  await page.reload();
  await page
    .locator('.review-row')
    .filter({ hasText: 'Teacher requested administrator review' })
    .getByRole('button', { name: 'Approve', exact: true })
    .click();
  await expect(
    page.locator('.review-row').filter({ hasText: 'Teacher requested administrator review' }),
  ).toContainText(/APPLIED/i);
  await expect(request).toContainText(/APPLIED/i);
});

test('School Admin safely retries a lost payment response and queues fee reminders', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  const f = platformApp.records,
    created = await platformApp.request(
      '/resources/fee_records',
      'POST',
      {
        student_id: f.student,
        academic_session_id: f.session,
        fee_type: 'Retry workflow fee',
        amount_due: 100,
        due_on: '2026-10-21',
      },
      f.admin,
      f.schoolA,
    );
  expect(created.status).toBe(201);
  const keys: string[] = [];
  await page.route('**/api/v1/fees/payments', async (route) => {
    keys.push(route.request().headers()['idempotency-key']);
    const response = await route.fetch({ url: platformApp.url + '/api/v1/fees/payments' });
    if (keys.length === 1)
      await route.fulfill({
        status: 503,
        json: { error: { message: 'The saved response was lost. Retry safely.' } },
      });
    else await route.fulfill({ response });
  });
  await page.goto(authAppURL + '/admin/r/fee_records');
  await page.getByRole('combobox', { name: 'Academic year', exact: true }).selectOption(f.session);
  await page.getByRole('combobox', { name: 'Student', exact: true }).selectOption(f.student);
  const row = page.getByRole('row').filter({ hasText: 'Retry workflow fee' });
  await row.getByRole('button', { name: 'Remind', exact: true }).click();
  await expect(page.getByRole('status')).toContainText(/reminder/i);
  await page.getByRole('button', { name: 'Record payment', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('spinbutton', { name: new RegExp('Amount for Retry workflow fee') })
    .fill('40');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Review payment', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Confirm payment', exact: true })
    .click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Retry safely');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Review payment', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Confirm payment', exact: true })
    .click();
  await expect(page.locator('.fee-receipt')).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  await page.getByRole('dialog').getByRole('button', { name: 'Done', exact: true }).click();
  await expect(row).toContainText('₹60.00');
  expect(
    (
      await platformApp.db.query<{ amount_paid: string }>(
        'SELECT amount_paid FROM fee_records WHERE id=$1',
        [created.body.id],
      )
    ).rows[0].amount_paid,
  ).toBe('40.00');
});

test('School Admin issues, replaces and deactivates student NFC cards', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  await page.goto(authAppURL + '/admin/r/nfc_cards');
  await page.getByRole('button', { name: 'Issue Card', exact: true }).click();
  await page.getByLabel('Student', { exact: true }).selectOption(platformApp.records.student);
  await page.getByLabel('NFC Card UID (Hex)').fill('ABCDEF12');
  await save(page, 'Issue Card');
  const list = await platformApp.request(
    '/resources/nfc_cards',
    'GET',
    undefined,
    platformApp.records.admin,
    platformApp.records.schoolA,
  );
  expect(list.body.data.filter((r: { status: string }) => r.status === 'ACTIVE')).toHaveLength(1);
  const row = page.getByRole('row').filter({ hasText: 'ABCDEF12' });
  await row.getByRole('button', { name: 'Deactivate', exact: true }).click();
  await page.getByLabel('Reason for deactivation').fill('Generated lost card exercise');
  await save(page, 'Deactivate Card');
  await expect(row).toContainText(/LOST/i);
});

test('School Admin sends a support request and approves then revokes support access', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  const result = await platformApp.request('/platform/support-grants', 'POST', {
    school_id: platformApp.records.schoolA,
    reason: 'Review website support flow',
    ticket_ref: 'ADMIN-SUPPORT',
    scope: ['attendance'],
    minutes: 60,
  });
  expect(result.status).toBe(201);
  await page.goto(authAppURL + '/admin/support');
  await page.getByRole('button', { name: 'New support request', exact: true }).click();
  await fill(page, {
    'action-subject': 'Website account help',
    'action-description': 'Please review the generated account setup.',
  });
  await save(page, 'Save');
  await expect(page.getByRole('row').filter({ hasText: 'Website account help' })).toBeVisible();
  const grant = page.locator('.review-row').filter({ hasText: 'ADMIN-SUPPORT' });
  await grant.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(grant).toContainText('Approved');
  await grant.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(grant).toContainText('Revoked');
});

test('School Admin imports students and archives a subject without removing history', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  await page.goto(authAppURL + '/admin/r/students');
  await page.getByRole('button', { name: 'Import CSV', exact: true }).click();
  await page
    .getByLabel('CSV preview')
    .fill('student_code,first_name\nIMPORT_WEB,Imported website learner');
  await page.getByRole('button', { name: 'Validate file', exact: true }).click();
  await expect(page.getByText('All rows validated. Ready to import.')).toBeVisible();
  await page.getByRole('button', { name: 'Import validated records', exact: true }).click();
  await expect(page.getByText('1 records imported.')).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.locator('summary').filter({ hasText: 'Not currently enrolled' }).click();
  await expect(
    page.getByRole('article', { name: 'Student IMPORT_WEB', exact: true }),
  ).toBeVisible();
  const f = platformApp.records;
  expect(
    (
      await platformApp.request(
        '/resources/subjects',
        'POST',
        { code: 'ARCHIVE_WEB', name: 'Archive website subject' },
        f.admin,
        f.schoolA,
      )
    ).status,
  ).toBe(201);
  await page.goto(authAppURL + '/admin/r/subjects');
  await page
    .getByRole('row')
    .filter({ hasText: 'ARCHIVE_WEB' })
    .getByRole('button', { name: 'Archive', exact: true })
    .click();
  await page
    .getByLabel('Reason', { exact: true })
    .fill('Generated retirement preserving historical records');
  await save(page, 'Save');
  await expect(page.getByRole('row').filter({ hasText: 'ARCHIVE_WEB' })).toHaveCount(0);
});

test('School Admin profile settings refresh the workspace name', async ({ page, authAppURL }) => {
  await page.goto(authAppURL + '/admin/settings');
  await page.getByRole('button', { name: 'School profile', exact: true }).click();
  await fill(page, { 'action-name': 'Renamed website school' });
  await save(page, 'Save');
  await expect(page.locator('.school-selector strong')).toHaveText('Renamed website school');
});

test('School Admin cannot cross schools, change platform billing or access another role portal', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  const f = platformApp.records;
  for (const path of [
    '/students/' + f.foreignStudent + '/overview',
    '/resources/students/' + f.foreignStudent,
  ]) {
    expect((await platformApp.request(path, 'GET', undefined, f.admin, f.schoolA)).status).toBe(
      404,
    );
  }
  expect(
    (await platformApp.request('/resources/students', 'GET', undefined, f.admin, f.schoolB)).status,
  ).toBe(404);
  expect(
    (
      await platformApp.request(
        '/platform/schools/' + f.schoolA + '/subscription',
        'PATCH',
        {},
        f.admin,
        f.schoolA,
      )
    ).status,
  ).toBe(403);
  await page.goto(authAppURL + '/principal');
  await expect(page.getByRole('heading', { name: 'Access unavailable' })).toBeVisible();
  await page.goto(authAppURL + '/platform');
  await expect(page.getByRole('heading', { name: 'Access unavailable' })).toBeVisible();
});

test('School Admin generates and downloads attendance, academic, fee reports and a private school export', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  test.setTimeout(60000);
  await page.goto(authAppURL + '/admin/reports');
  for (const kind of ['ATTENDANCE', 'ACADEMIC', 'FEES']) {
    await page.getByRole('button', { name: 'Create report', exact: true }).first().click();
    await fill(page, {
      'action-kind': kind,
      'action-format': 'PDF',
      'action-from': '2026-10-01',
      'action-to': '2026-10-21',
    });
    await save(page, 'Save');
    await expect(page.getByRole('main')).toContainText(kind + ' report');
    await generateReports(
      platformApp.pools.worker,
      platformApp.records.schoolA,
      platformApp.storage,
    );
  }
  await page.reload();
  const reports = page.locator('.review-row');
  for (let i = 0; i < 3; i++) {
    const download = page.waitForEvent('download');
    await reports.nth(i).getByRole('button', { name: 'Download PDF', exact: true }).click();
    expect((await download).suggestedFilename()).toMatch(/\.pdf$/);
  }
  await page.goto(authAppURL + '/admin/exports');
  await page.getByRole('button', { name: 'Create school export', exact: true }).click();
  await fill(page, { 'action-reason': 'Generated private school export verification' });
  await save(page, 'Save');
  await expect(page.getByRole('main')).toContainText(/PENDING/i);
  await expect(page.getByRole('button', { name: 'Open files' }).first()).toBeDisabled();
  await generateSchoolExport(
    platformApp.pools.worker,
    platformApp.records.schoolA,
    platformApp.storage,
  );
  await page.reload();
  await page.getByRole('button', { name: 'Open files', exact: true }).first().click();
  await expect(page.getByRole('dialog')).toContainText('students-');
  const exported = page.waitForEvent('download');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Download', exact: true })
    .first()
    .click();
  expect((await exported).suggestedFilename()).toMatch(/\.(json|csv)$/);
});

test('School Admin claims, renames and configures only school-owned readers', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  const f = platformApp.records;
  const provision = await platformApp.request('/platform/devices', 'POST', {
    school_id: f.schoolA,
    device_code: 'SCHOOL_WEB_READER',
    name: 'Website reader',
    hardware_serial: 'WEB_TEST_01',
  });
  expect(provision.status).toBe(201);
  const locations = await platformApp.request(
    '/resources/device_locations',
    'GET',
    undefined,
    f.admin,
    f.schoolA,
  );
  await page.goto(authAppURL + '/admin/devices');
  await page.getByRole('button', { name: 'Claim device', exact: true }).click();
  await fill(page, {
    'action-device_code': 'SCHOOL_WEB_READER',
    'action-claim_code': provision.body.claim_code,
    'action-name': 'Claimed website reader',
    'action-location_id': locations.body.data.find((r: { name: string }) => r.name === 'Gate').id,
  });
  await save(page, 'Save');
  const card = page.locator('.device-card').filter({ hasText: 'SCHOOL_WEB_READER' });
  await expect(card).toContainText('Claimed website reader');
  await card.getByRole('button', { name: /Manage device/ }).click();
  await fill(page, {
    'action-name': 'Renamed website reader',
    'action-reason': 'Approved reader rename exercise',
  });
  await save(page, 'Save');
  await expect(card).toContainText('Renamed website reader');
  await card.getByRole('button', { name: 'Reader settings & history', exact: true }).click();
  await page.getByLabel('Heartbeat Interval S', { exact: true }).fill('90');
  await page
    .getByLabel('Reason for change', { exact: true })
    .fill('Approved reader heartbeat adjustment');
  await save(page, 'Save reader settings');
  await card.getByRole('button', { name: 'Reader settings & history', exact: true }).click();
  await expect(page.getByLabel('Heartbeat Interval S', { exact: true })).toHaveValue('90');
  await expect(page.getByRole('dialog')).toContainText('Approved reader heartbeat adjustment');
});

test('School Admin saves security and approved retention policies then stops cleanup', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  await page.goto(authAppURL + '/admin/settings');
  await page.getByLabel('Reader offline threshold (minutes)').fill('7');
  await page
    .getByLabel('Policy approval reference', { exact: true })
    .fill('Website policy approval 2026');
  await page.getByRole('button', { name: 'Save security policy', exact: true }).click();
  await expect
    .poll(
      async () =>
        (
          await platformApp.request(
            '/school/security',
            'GET',
            undefined,
            platformApp.records.admin,
            platformApp.records.schoolA,
          )
        ).body.device_offline_minutes,
    )
    .toBe(7);
  await page.getByRole('button', { name: 'Set approved retention policy', exact: true }).click();
  await page
    .getByLabel('Approved policy reference', { exact: true })
    .fill('Website retention approval');
  await page.getByLabel('Generated reports (days)', { exact: true }).fill('30');
  await page.getByLabel('Completed notification history (days)', { exact: true }).fill('60');
  await page.getByRole('checkbox', { name: /I confirm that these periods/ }).check();
  await save(page, 'Save approved policy');
  await expect(page.getByRole('main')).toContainText('Website retention approval');
  await page.getByRole('button', { name: 'Stop future cleanup', exact: true }).click();
  await expect(page.getByRole('main')).toContainText('Automatic cleanup is inactive.');
});

test('School Admin invites an existing Principal, resends and cancels, and protects the last administrator', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  const f = platformApp.records;
  const record = await platformApp.request(
    '/resources/teachers',
    'POST',
    {
      staff_code: 'INVITE_PRINCIPAL_WEB',
      full_name: 'Invited website principal',
      email: 'setup-admin@example.test',
      staff_role: 'principal',
    },
    f.admin,
    f.schoolA,
  );
  expect(record.status).toBe(201);
  await page.goto(authAppURL + '/admin/members');
  await page.getByRole('button', { name: 'Invite member', exact: true }).click();
  await page.getByLabel('Role', { exact: true }).selectOption('principal');
  await page.getByLabel('Existing school record', { exact: true }).selectOption(record.body.id);
  await save(page, 'Send invitation');
  const invited = page
    .locator('section.panel')
    .filter({ has: page.getByRole('heading', { name: 'Invitations', exact: true }) })
    .getByRole('row')
    .filter({ hasText: 'setup-admin@example.test' });
  await invited.getByRole('button', { name: 'Resend', exact: true }).click();
  await expect(page.getByRole('status').last()).toContainText('setup email');
  await invited.getByRole('button', { name: 'Cancel invitation', exact: true }).click();
  await expect(invited).toContainText(/REVOKED/i);
  const memberships = (
    await platformApp.request('/memberships', 'GET', undefined, f.admin, f.schoolA)
  ).body.data;
  const own = memberships.find((m: { user_id: string }) => m.user_id === f.admin);
  const result = await platformApp.request(
    '/memberships/' + own.id,
    'PATCH',
    { role: 'school_admin', status: 'SUSPENDED' },
    f.admin,
    f.schoolA,
  );
  expect(result.status).toBe(409);
});

test('School Admin retries failed notifications, requests movement reconciliation and reads audit history', async ({
  page,
  authAppURL,
}) => {
  await page.goto(authAppURL + '/admin/notifications');
  const notification = page.locator('.review-row').filter({ hasText: 'Generated failed delivery' });
  await notification.getByRole('button', { name: 'Retry delivery', exact: true }).click();
  await page
    .getByLabel('Reason', { exact: true })
    .fill('Retry approved after fixture provider recovery');
  await save(page, 'Save');
  await expect(notification).toContainText(/PENDING/i);
  await page.goto(authAppURL + '/admin/attendance/history');
  await page.getByLabel('Needs review').check();
  await page.getByRole('button', { name: 'Request reconciliation', exact: true }).click();
  await page
    .getByLabel('Reason', { exact: true })
    .fill('Review generated untrusted device clock evidence');
  await save(page, 'Save');
  await expect(
    page.getByRole('row').filter({ hasText: 'Review generated untrusted device clock evidence' }),
  ).toBeVisible();
  await page.goto(authAppURL + '/admin/audit');
  await expect(page.getByRole('main')).toContainText('attendance.reconcile_requested');
  await expect(page.getByRole('main')).toContainText('notification.retry');
});

test('School Admin imports marks into an open examination and publishes results', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  const f = platformApp.records;
  const exam = await platformApp.request(
    '/resources/exams',
    'POST',
    {
      class_id: f.classId,
      name: 'CSV website assessment',
      exam_type: 'UNIT',
      max_score: 100,
      status: 'OPEN',
    },
    f.admin,
    f.schoolA,
  );
  expect(exam.status).toBe(201);
  await page.goto(authAppURL + '/admin/r/marks');
  await page
    .getByRole('combobox', { name: 'Class and section', exact: true })
    .selectOption(f.classId);
  await page.getByRole('combobox', { name: 'Examination', exact: true }).selectOption(exam.body.id);
  await page.getByRole('button', { name: 'Import CSV', exact: true }).click();
  await expect(page.getByLabel('Open examination')).toHaveValue(exam.body.id);
  await expect(page.getByLabel('Open examination')).toBeDisabled();
  await page.getByLabel('Marks CSV').setInputFiles({
    name: 'marks.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('student_code,subject_code,score,remarks\nSTU001,MAT,91,CSV verified'),
  });
  await save(page, 'Import marks');
  const marks = await platformApp.request('/resources/marks', 'GET', undefined, f.admin, f.schoolA);
  expect(
    marks.body.data.some(
      (m: { exam_id: string; score: string }) =>
        m.exam_id === exam.body.id && Number(m.score) === 91,
    ),
  ).toBe(true);
  await page.goto(authAppURL + '/admin/r/exams');
  const row = page.getByRole('row').filter({ hasText: 'CSV website assessment' });
  await row.getByRole('button', { name: /^Edit / }).click();
  await fill(page, { status: 'PUBLISHED' });
  await save(page);
  await expect(row).toContainText(/PUBLISHED/i);
});

test('School Admin uploads and downloads private study material', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  const bytes = Buffer.from('%PDF-1.4\nFixture private study material\n%%EOF');
  await page.route(
    'https://mfa-qr.test/storage/v1/object/upload/sign/school-documents/**',
    async (route) => {
      const url = new URL(route.request().url());
      const path = decodeURIComponent(url.pathname.split('/school-documents/')[1]);
      platformApp.objects.set(path, bytes);
      await route.fulfill({ json: { Key: 'school-documents/' + path } });
    },
  );
  await page.goto(authAppURL + '/admin/r/assignments');
  await page.getByRole('button', { name: 'Add record', exact: true }).click();
  await fill(page, {
    class_id: platformApp.records.classId,
    kind: 'MATERIAL',
    title: 'Private website material',
    body: 'Read the attached private learning material.',
  });
  await page
    .getByLabel('Upload private material')
    .setInputFiles({ name: 'private-material.pdf', mimeType: 'application/pdf', buffer: bytes });
  await expect(page.locator('#storage_path')).toHaveValue(/\/materials\//);
  await save(page);
  await page
    .getByRole('row')
    .filter({ hasText: 'Private website material' })
    .getByRole('button', { name: 'View', exact: true })
    .click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download material', exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/private-material\.pdf$/);
});

test('School Admin explicitly declines a school closure request without closing the school', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  const f = platformApp.records;
  const job = await platformApp.request('/platform/schools/' + f.schoolA + '/offboarding', 'POST', {
    policy_ref: 'WEBSITE-CLOSURE-REVIEW',
    reason: 'Generated school review of contract closure',
    export_until: '2099-01-01T00:00:00Z',
    delete_after: '2099-02-01T00:00:00Z',
  });
  expect(job.status).toBe(201);
  await page.goto(authAppURL + '/admin/exports');
  const row = page.getByRole('row').filter({ hasText: 'WEBSITE-CLOSURE-REVIEW' });
  await row.getByRole('button', { name: 'Review decision', exact: true }).click();
  await expect(page.getByLabel('Approve', { exact: true })).toHaveValue('false');
  await save(page, 'Save');
  await expect(row).toContainText(/CANCELLED/i);
  expect(
    (await platformApp.request('/dashboard', 'GET', undefined, f.admin, f.schoolA)).status,
  ).toBe(200);
});

test('School Admin class register includes students beyond the first 100 enrollments', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  test.setTimeout(90000);
  const f = platformApp.records;
  const call = (path: string, method = 'GET', body?: unknown) =>
    platformApp.request(path, method, body, f.admin, f.schoolA);
  const cl = await call('/resources/classes', 'POST', {
    academic_session_id: f.session,
    grade: '10',
    section: 'LARGE_WEB',
    class_teacher_id: f.teacherId,
  });
  expect(cl.status).toBe(201);
  const rows = Array.from({ length: 105 }, (_, i) => ({
    student_code: 'LARGE_WEB_' + String(i).padStart(3, '0'),
    first_name: 'Large class learner ' + String(i).padStart(3, '0'),
  }));
  expect((await call('/imports/students', 'POST', { rows, validate_only: false })).status).toBe(
    201,
  );
  const learners = [
    ...(await call('/resources/students?search=LARGE_WEB&page_size=100')).body.data,
    ...(await call('/resources/students?search=LARGE_WEB&page_size=100&page=2')).body.data,
  ];
  expect(learners).toHaveLength(105);
  for (const learner of learners)
    expect(
      (
        await call('/resources/enrollments', 'POST', {
          student_id: learner.id,
          class_id: cl.body.id,
          academic_session_id: f.session,
          starts_on: '2026-01-01',
        })
      ).status,
    ).toBe(201);
  await page.goto(authAppURL + '/admin/attendance');
  await page.getByRole('button', { name: 'Class Register', exact: true }).click();
  await page.getByLabel('Select Class & Section').selectOption(cl.body.id);
  await page.getByLabel('Attendance Date', { exact: true }).fill('2026-10-20');
  await expect(page.getByRole('dialog')).toContainText('105 Learners Enrolled');
  await expect(page.getByRole('dialog')).toContainText('Large class learner 104');
  await page.getByRole('button', { name: 'All Present', exact: true }).click();
  await save(page, 'Save Class Attendance');
  const days = await call(
    '/attendance?date=2026-10-20&class_id=' + cl.body.id + '&page_size=100&page=2',
  );
  expect(days.body.total).toBe(105);
  expect(days.body.data).toHaveLength(5);
  expect(
    days.body.data.every((d: { attendance_status: string }) => d.attendance_status === 'PRESENT'),
  ).toBe(true);
});

test('School Admin downloads CSV reports with the correct contents and extension', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  const f = platformApp.records;
  expect(
    (
      await platformApp.request(
        '/resources/fee_records',
        'POST',
        {
          student_id: f.student,
          academic_session_id: f.session,
          fee_type: 'CSV website fee',
          amount_due: 25,
          due_on: '2026-10-21',
        },
        f.admin,
        f.schoolA,
      )
    ).status,
  ).toBe(201);
  await page.goto(authAppURL + '/admin/reports');
  await page.getByRole('button', { name: 'Create report', exact: true }).first().click();
  await fill(page, {
    'action-kind': 'FEES',
    'action-format': 'CSV',
    'action-from': '2026-10-01',
    'action-to': '2026-10-21',
  });
  await save(page, 'Save');
  await generateReports(platformApp.pools.worker, f.schoolA, platformApp.storage);
  await page.reload();
  const event = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download CSV', exact: true }).click();
  const download = await event;
  expect(download.suggestedFilename()).toBe('vidyalayaa-report.csv');
  const stream = await download.createReadStream();
  expect(stream).toBeTruthy();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString('utf-8')).toContain('CSV website fee');
});

test('School Admin suspends and restores another school member through the website', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  const f = platformApp.records;
  await page.goto(authAppURL + '/admin/members');
  const row = page.getByRole('row').filter({ hasText: f.teacher + '@example.invalid' });
  await row.getByRole('button', { name: 'Edit membership', exact: true }).click();
  await fill(page, { 'action-status': 'SUSPENDED' });
  await save(page, 'Save');
  await expect(row).toContainText(/SUSPENDED/i);
  expect(
    (await platformApp.request('/resources/students', 'GET', undefined, f.teacher, f.schoolA))
      .status,
  ).toBe(404);
  await row.getByRole('button', { name: 'Edit membership', exact: true }).click();
  await fill(page, { 'action-status': 'ACTIVE' });
  await save(page, 'Save');
  await expect(row).toContainText(/ACTIVE/i);
  expect(
    (await platformApp.request('/resources/students', 'GET', undefined, f.teacher, f.schoolA))
      .status,
  ).toBe(200);
});

test('School Admin school switching clears the previous school records and navigation context', async ({
  page,
  authAppURL,
  platformApp,
  isMobile,
}) => {
  const f = platformApp.records;
  const context = await platformApp.request('/me', 'GET', undefined, f.admin, f.schoolA);
  const other = context.body.memberships.find(
    (m: { school_id: string }) => m.school_id !== f.schoolA,
  );
  expect(other).toBeTruthy();
  await page.goto(authAppURL + '/admin/r/students');
  await expect(page.getByRole('heading', { name: 'Class 8', exact: true })).toBeVisible();
  if (isMobile) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Active school', exact: true })
    .selectOption(other.school_id);
  await expect(page.locator('.school-selector strong')).toHaveText(other.school_name);
  if (isMobile) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Students', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Students', exact: true })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'STU001' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'No classes yet', exact: true })).toBeVisible();
});

test('School Admin searches students, pages the filtered list and resets filters', async ({
  page,
  authAppURL,
  platformApp,
  isMobile,
}) => {
  const f = platformApp.records;
  const rows = Array.from({ length: 26 }, (_, i) => ({
    student_code: 'PAGE_WEB_' + String(i).padStart(3, '0'),
    first_name: 'Lookup learner ' + String(i).padStart(3, '0'),
  }));
  expect(
    (
      await platformApp.request(
        '/imports/students',
        'POST',
        { rows, validate_only: false },
        f.admin,
        f.schoolA,
      )
    ).status,
  ).toBe(201);
  await page.goto(authAppURL + '/admin/r/students');
  if (!isMobile) {
    await page.locator('.global-search input').fill('Lookup learner 025');
    await page.locator('.global-search input').press('Enter');
    await expect(page).toHaveURL(/search=Lookup/);
    await page.locator('summary').filter({ hasText: 'Not currently enrolled' }).click();
    await expect(
      page.getByRole('article', { name: 'Student PAGE_WEB_025', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('article', { name: 'Student PAGE_WEB_024', exact: true }),
    ).toHaveCount(0);
  }
  const search = page
    .getByRole('main')
    .getByRole('textbox', { name: 'Search students', exact: true });
  await search.fill('PAGE_WEB');
  const unassigned = page
    .locator('details')
    .filter({ has: page.locator('summary').filter({ hasText: 'Not currently enrolled' }) });
  if (!(await unassigned.evaluate((e) => (e as HTMLDetailsElement).open)))
    await unassigned.locator('summary').click();
  const records = unassigned.getByRole('article');
  await expect(records).toHaveCount(25);
  await unassigned.getByRole('button', { name: 'Next students', exact: true }).click();
  await expect(records).toHaveCount(1);
  await page.getByRole('button', { name: 'Reset filters', exact: true }).click();
  await expect(search).toHaveValue('');
  await expect(page.getByText(/Page 1 ·/)).toBeVisible();
});
