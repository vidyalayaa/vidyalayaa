import { expect } from '@playwright/test';
import { test as base } from './fixtures/family-calendar-app';
import { parentScenario } from '../helpers/parent-workspace';
import { sampleRule } from '../../apps/web/src/features/resources/metadata';
// This scenario owns a fresh worker database so its extra marks/attendance do
// not change the separate parent-workspace regression fixture.
const test = base.extend<{}, { insightsIsolation: void }>({
  insightsIsolation: [
    async ({}, use) => {
      await use();
    },
    { scope: 'worker', auto: true },
  ],
});
test.setTimeout(120000);
test('shows daily attendance summaries, absence corrections and normalized published result charts for only the selected child', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  const f = platformApp.records,
    s = await parentScenario(platformApp.db, f),
    db = platformApp.db;
  await db.query(
    "INSERT INTO attendance_rule_versions(school_id,class_id,day_type,version_no,effective_from,effective_to,rules,created_by) VALUES($1,$2,'REGULAR',1,'2026-10-01','2026-10-08',$3,$4)",
    [f.schoolA, f.classId, { ...sampleRule, weekly_off: ['SAT', 'SUN'] }, f.admin],
  );
  for (const [date, status] of [
    ['2026-10-01', 'PRESENT'],
    ['2026-10-05', 'ABSENT'],
    ['2026-10-06', 'LATE'],
    ['2026-10-07', 'PENDING'],
  ])
    await db.query(
      'INSERT INTO daily_attendance(school_id,student_id,class_id,academic_session_id,attendance_date,attendance_status) VALUES($1,$2,$3,$4,$5,$6)',
      [f.schoolA, f.student, f.classId, f.session, date, status],
    );
  await db.query(
    "INSERT INTO school_holidays(school_id,label,on_date,kind,target_class_ids) VALUES($1,'Section holiday','2026-10-02','HOLIDAY',$2),($1,'Sunday school','2026-10-04','WEEKEND_OVERRIDE',$2)",
    [f.schoolA, [f.classId]],
  );
  const exam = (
    await db.query<{ id: string }>(
      "INSERT INTO exams(school_id,class_id,name,exam_type,max_score,status,assessment_kind,subject_id,starts_on) VALUES($1,$2,'Second exam','UNIT',50,'OPEN','SUBJECT_TEST',$3,'2026-10-05') RETURNING id",
      [f.schoolA, f.classId, f.subject],
    )
  ).rows[0].id;
  await db.query(
    'INSERT INTO marks(school_id,student_id,exam_id,subject_id,score,entered_by) VALUES($1,$2,$3,$4,25,$5)',
    [f.schoolA, f.student, exam, f.subject, f.admin],
  );
  await db.query("UPDATE exams SET status='PUBLISHED' WHERE id=$1", [exam]);
  await db.query("UPDATE exams SET starts_on='2026-10-06' WHERE id=$1", [s.exams[f.student]]);
  await page.goto(authAppURL + '/parent/attendance?child_id=' + f.student);
  await page.getByLabel('From date', { exact: true }).fill('2026-10-01');
  await page.getByLabel('To date', { exact: true }).fill('2026-10-07');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  const metric = (title: string) =>
    page.locator('article').filter({ has: page.getByText(title, { exact: true }) });
  await expect(metric('Total school days')).toContainText('5');
  await expect(metric('Absent days')).toContainText('1');
  await expect(metric('Attendance percentage')).toContainText('66.7%');
  await expect(
    page
      .getByRole('row')
      .filter({ has: page.getByRole('cell', { name: '2026-10-02', exact: true }) }),
  ).toContainText(/holiday/i);
  await expect(
    page
      .getByRole('row')
      .filter({ has: page.getByRole('cell', { name: '2026-10-04', exact: true }) }),
  ).toContainText(/not recorded/i);
  await page
    .getByRole('combobox', { name: 'Attendance status', exact: true })
    .selectOption('ABSENT');
  await expect(page.getByRole('row')).toHaveCount(2);
  await expect(metric('Total school days')).toContainText('5');
  await page.getByRole('button', { name: 'Request correction', exact: true }).click();
  await page.getByRole('dialog').locator('textarea').fill('Please check this absence.');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /Save|Submit/ })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const day = (
    await db.query<{ attendance_status: string }>(
      "SELECT attendance_status FROM daily_attendance WHERE school_id=$1 AND student_id=$2 AND attendance_date='2026-10-05'",
      [f.schoolA, f.student],
    )
  ).rows[0];
  expect(day.attendance_status).toBe('ABSENT');
  await page.goto(authAppURL + '/parent/r/marks?child_id=' + f.student);
  await page.getByLabel('From date', { exact: true }).fill('2026-10-01');
  await page.getByLabel('To date', { exact: true }).fill('2026-10-07');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(
    page.getByRole('img', { name: 'Published results by subject, in percent', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('img', { name: 'Published examination progress, in percent', exact: true }),
  ).toBeVisible();
  await expect(metric('Overall result')).toContainText('66.7%');
  await page.getByRole('combobox', { name: 'Result examination', exact: true }).selectOption(exam);
  await expect(metric('Overall result')).toContainText('50%');
  await expect(page.getByRole('cell', { name: 'First exam', exact: true })).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Your child', exact: true }).selectOption(s.sibling);
  await expect(metric('Overall result')).toContainText('75%');
  await expect(page.getByRole('cell', { name: 'Second exam', exact: true })).toHaveCount(0);
  await expect(page.getByRole('cell', { name: 'Sibling exam', exact: true })).toBeVisible();
  await page.goto(authAppURL + '/parent/r/marks?child_id=' + s.privateChild);
  await expect(
    page.getByRole('heading', { name: 'Child access unavailable', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('img', { name: 'Published results by subject, in percent', exact: true }),
  ).toHaveCount(0);
});
