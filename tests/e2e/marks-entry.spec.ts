import { expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { test } from './fixtures/school-admin-app';
import { parseCsv } from '../../apps/web/src/lib/csv';
test.setTimeout(120000);
test('marks CSV imports when spreadsheet software removes leading zeros from subject codes and rolls', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  const f = platformApp.records,
    call = (path: string, method = 'GET', body?: unknown) =>
      platformApp.request(path, method, body, f.admin, f.schoolA);
  const classroom = await call('/resources/classes', 'POST', {
    grade: '2',
    section: 'CSV_ZERO',
    academic_session_id: f.session,
    class_teacher_id: f.teacherId,
  });
  expect(classroom.status).toBe(201);
  const classId = classroom.body.id;
  const configured = await call(`/academics/classes/${classId}/subjects`, 'POST', {
    subject: { code: '0205', name: 'Computer import regression' },
    teacher_id: f.teacherId,
    starts_on: '2026-01-01',
  });
  expect(configured.status).toBe(201);
  const sid = configured.body.subject.id;
  const student = await call('/resources/students', 'POST', {
    student_code: 'ZERO_IMPORT',
    first_name: 'Zero-code learner',
  });
  expect(student.status).toBe(201);
  expect(
    (
      await call('/resources/enrollments', 'POST', {
        student_id: student.body.id,
        class_id: classId,
        academic_session_id: f.session,
        roll_number: '003',
        starts_on: '2026-01-01',
      })
    ).status,
  ).toBe(201);
  const exam = await call('/resources/exams', 'POST', {
    name: 'Spreadsheet zero import',
    class_id: classId,
    assessment_kind: 'SUBJECT_TEST',
    subject_id: sid,
    exam_type: 'UNIT',
    max_score: 100,
    status: 'OPEN',
  });
  expect(exam.status).toBe(201);
  await page.goto(authAppURL + '/admin/r/marks');
  await page.getByLabel('Class and section', { exact: true }).selectOption(classId);
  await page.getByLabel('Examination', { exact: true }).selectOption(exam.body.id);
  await page.getByRole('button', { name: 'Import CSV', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download filled CSV template', exact: true }).click();
  const stream = await (await download).createReadStream(),
    chunks: Buffer[] = [];
  for await (const c of stream!) chunks.push(Buffer.from(c));
  const [header, ...rows] = parseCsv(Buffer.concat(chunks).toString('utf8'));
  const row = rows.find((r) => r[header.indexOf('student_code')] === 'ZERO_IMPORT')!;
  expect(row[header.indexOf('subject_code')]).toBe('0205');
  expect(row[header.indexOf('roll_number')]).toBe('003');
  row[header.indexOf('subject_code')] = '205';
  row[header.indexOf('roll_number')] = '3';
  row[header.indexOf('score')] = '88';
  row[header.indexOf('remarks')] = 'good';
  await page.getByLabel('Marks CSV', { exact: true }).setInputFiles({
    name: 'spreadsheet-saved-marks.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      [header, ...rows]
        .map((r) => r.map((v) => '"' + v.replaceAll('"', '""') + '"').join(','))
        .join('\n'),
    ),
  });
  await page.getByRole('button', { name: 'Import marks', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const marks = (await call('/resources/marks?exam_id=' + exam.body.id)).body.data;
  expect(marks).toHaveLength(1);
  expect(marks[0].student_id).toBe(student.body.id);
  expect(marks[0].subject_id).toBe(sid);
  expect(Number(marks[0].score)).toBe(88);
});
test('prefilled class CSV and Enter-by-roll marks preserve zero, safe retries, class scope and locked examinations', async ({
  page,
  authAppURL,
  platformApp,
}, info) => {
  const f = platformApp.records,
    call = (path: string, method = 'GET', body?: unknown) =>
      platformApp.request(path, method, body, f.admin, f.schoolA);
  const enrollments = (await call('/resources/enrollments?student_id=' + f.student)).body.data;
  expect(
    (
      await call(
        '/resources/enrollments/' + enrollments.find((e: any) => e.class_id === f.classId).id,
        'PATCH',
        { roll_number: '10' },
      )
    ).status,
  ).toBe(200);
  const child = await call('/resources/students', 'POST', {
    student_code: 'ROLL_TWO',
    first_name: 'Roll Two',
  });
  expect(child.status).toBe(201);
  expect(
    (
      await call('/resources/enrollments', 'POST', {
        student_id: child.body.id,
        class_id: f.classId,
        academic_session_id: f.session,
        starts_on: '2026-01-01',
        roll_number: '2',
      })
    ).status,
  ).toBe(201);
  const exam = await call('/resources/exams', 'POST', {
    name: 'Roll and CSV browser',
    class_id: f.classId,
    assessment_kind: 'SUBJECT_TEST',
    subject_id: f.subject,
    exam_type: 'UNIT',
    max_score: 50,
    status: 'OPEN',
  });
  expect(exam.status).toBe(201);
  let drop = true;
  const keys: string[] = [];
  await page.route('**/api/v1/marks/entry', async (route) => {
    keys.push(route.request().headers()['idempotency-key']);
    const response = await route.fetch({ url: platformApp.url + '/api/v1/marks/entry' });
    if (drop) {
      drop = false;
      expect(response.status()).toBe(200);
      await route.abort('failed');
    } else await route.fulfill({ response });
  });
  await page.goto(authAppURL + '/admin/r/marks');
  await page.getByLabel('Class and section', { exact: true }).selectOption(f.classId);
  await page.getByLabel('Examination', { exact: true }).selectOption(exam.body.id);
  await page.getByRole('button', { name: 'Enter by roll number', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Roll number: 2');
  const score = dialog.getByRole('spinbutton', { name: 'Score (maximum 50)', exact: true });
  await score.fill('0');
  await score.press('Enter');
  await expect(dialog).toContainText('Roll number: 10');
  await expect(dialog.getByRole('alert')).toBeVisible();
  await dialog.getByRole('button', { name: 'Retry pending saves', exact: true }).click();
  await expect(dialog.getByText('All entered marks saved.', { exact: true })).toBeVisible();
  expect(keys[0]).toBe(keys[1]);
  await expect(score).toHaveValue('');
  await score.fill('51');
  await score.press('Enter');
  await expect(dialog.getByRole('alert')).toContainText('0 to 50');
  await expect(dialog).toContainText('Roll number: 10');
  const axe = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
  expect(axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact || ''))).toEqual(
    [],
  );
  await score.fill('37');
  await page.screenshot({
    path: `tmp/qa/marks-roll-entry-${info.project.name}.png`,
    fullPage: true,
  });
  await score.press('Enter');
  await expect(dialog.getByRole('heading', { name: 'End of this class roster' })).toBeVisible();
  await expect(dialog.getByText('All entered marks saved.', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Import CSV', exact: true }).click();
  const downloaded = page.waitForEvent('download');
  await page.screenshot({
    path: `tmp/qa/marks-csv-template-${info.project.name}.png`,
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Download filled CSV template', exact: true }).click();
  const stream = await (await downloaded).createReadStream();
  const chunks: Buffer[] = [];
  for await (const c of stream!) chunks.push(Buffer.from(c));
  const [headers, ...rows] = parseCsv(Buffer.concat(chunks).toString('utf8'));
  expect(rows.map((r) => r[headers.indexOf('roll_number')])).toEqual(['2', '10']);
  expect(rows[0][headers.indexOf('score')]).toBe('0');
  expect(rows[1][headers.indexOf('score')]).toBe('37');
  expect(rows.some((r) => r.includes('Foreign learner'))).toBe(false);
  rows[0][headers.indexOf('score')] = '';
  rows[1][headers.indexOf('score')] = '39';
  await page.getByLabel('Marks CSV', { exact: true }).setInputFiles({
    name: 'filled-marks.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      [headers, ...rows]
        .map((r) => r.map((v) => '"' + v.replaceAll('"', '""') + '"').join(','))
        .join('\n'),
    ),
  });
  await page.getByRole('button', { name: 'Import marks', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const marks = (await call('/resources/marks?exam_id=' + exam.body.id)).body.data;
  expect(Number(marks.find((m: any) => m.student_id === child.body.id).score)).toBe(0);
  expect(Number(marks.find((m: any) => m.student_id === f.student).score)).toBe(39);
  expect(
    (await call('/resources/exams/' + exam.body.id, 'PATCH', { status: 'LOCKED' })).status,
  ).toBe(200);
  await page.reload();
  await page.getByLabel('Class and section', { exact: true }).selectOption(f.classId);
  await page.getByLabel('Examination', { exact: true }).selectOption(exam.body.id);
  await expect(page.getByRole('button', { name: 'Enter by roll number', exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole('button', { name: 'Import CSV', exact: true })).toHaveCount(0);
  await page.screenshot({ path: `tmp/qa/marks-entry-${info.project.name}.png`, fullPage: true });
});
