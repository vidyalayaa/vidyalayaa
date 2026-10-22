import { expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { test } from './fixtures/school-admin-app';
test.setTimeout(120000);
async function field(page: Page, id: string, value: string) {
  const control = page
    .getByRole('dialog')
    .last()
    .locator('#' + id);
  if ((await control.evaluate((e) => e.tagName)) === 'SELECT') await control.selectOption(value);
  else await control.fill(value);
}
async function save(page: Page) {
  await page
    .getByRole('dialog', { name: /^(Add|Edit) calendar event$/ })
    .getByRole('button', { name: 'Save event', exact: true })
    .click();
  await expect(page.getByRole('dialog', { name: /^(Add|Edit) calendar event$/ })).toHaveCount(0);
}
async function month(page: Page, url: string, year = '2027', value = '2') {
  await page.goto(url + '/admin/calendar');
  await page.getByLabel('Calendar year', { exact: true }).selectOption(year);
  await page.getByRole('button', { name: 'Month view', exact: true }).click();
  await page.getByLabel('Calendar month', { exact: true }).selectOption(value);
  await expect(page.locator('[data-date]').first()).toBeVisible();
}

test('School Admin creates, edits and deletes one multi-day event with class and section targets from a selected date', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  const f = platformApp.records;
  const other = await platformApp.request(
    '/resources/classes',
    'POST',
    { academic_session_id: f.session, grade: '8', section: 'CAL_B', class_teacher_id: f.teacherId },
    f.admin,
    f.schoolA,
  );
  expect(other.status).toBe(201);
  await month(page, authAppURL);
  await page.locator('[data-date="2027-03-10"]').click();
  await page.getByRole('button', { name: 'Add event on this date', exact: true }).click();
  await expect(page.getByRole('dialog').last().locator('#event-start')).toHaveValue('2027-03-10');
  await expect(page.getByRole('dialog').last().locator('#event-end')).toHaveValue('2027-03-10');
  await field(page, 'event-title', 'Calendar sports days');
  await field(page, 'event-description', 'Bring your sports kit.');
  await field(page, 'event-kind', 'ACTIVITY');
  await field(page, 'event-end', '2027-03-12');
  await field(page, 'event-audience', 'CLASSES');
  await page.getByRole('checkbox', { name: 'Class 8 Section A · Test year', exact: true }).check();
  const formAccessibility = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
  expect(
    formAccessibility.violations.filter((v) => ['serious', 'critical'].includes(v.impact || '')),
  ).toEqual([]);
  await save(page);
  await expect(
    page.getByRole('article', { name: 'Calendar event Calendar sports days', exact: true }),
  ).toBeVisible();
  const result = await platformApp.request(
      '/calendar/events?from=2027-03-10&to=2027-03-12',
      'GET',
      undefined,
      f.admin,
      f.schoolA,
    ),
    event = result.body.data.find((r: any) => r.title === 'Calendar sports days');
  expect(event.class_ids).toEqual([f.classId]);
  await page.getByRole('button', { name: 'Edit event Calendar sports days', exact: true }).click();
  await field(page, 'event-title', 'Calendar examinations');
  await field(page, 'event-kind', 'EXAM_DAY');
  await field(page, 'event-start', '2027-03-11');
  await field(page, 'event-end', '2027-03-13');
  await page
    .getByRole('checkbox', { name: 'All sections of Class 8 · Test year', exact: true })
    .check();
  await save(page);
  await expect(page.getByRole('dialog')).toContainText('No events on this date');
  await page.getByRole('dialog').getByRole('button', { name: 'Close dialog', exact: true }).click();
  for (const date of ['2027-03-11', '2027-03-12', '2027-03-13'])
    await expect(page.locator(`[data-date="${date}"]`)).toHaveAccessibleName(/1 event.*Exam/);
  await page.locator('[data-date="2027-03-11"]').click();
  await page
    .getByRole('button', { name: 'Delete event Calendar examinations', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: 'Delete calendar event', exact: true })
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();
  expect(
    (
      await platformApp.request(
        '/calendar/events/' + event.id,
        'GET',
        undefined,
        f.admin,
        f.schoolA,
      )
    ).body.class_ids.sort(),
  ).toEqual([f.classId, other.body.id].sort());
  await page
    .getByRole('button', { name: 'Delete event Calendar examinations', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: 'Delete calendar event', exact: true })
    .getByRole('button', { name: 'Delete event', exact: true })
    .click();
  await expect(
    page.getByRole('dialog', { name: 'Delete calendar event', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('dialog')).toContainText('No events on this date');
  expect(
    (
      await platformApp.request(
        '/calendar/events/' + event.id,
        'GET',
        undefined,
        f.admin,
        f.schoolA,
      )
    ).status,
  ).toBe(404);
  expect(
    (await platformApp.db.query('SELECT retired_at FROM school_holidays WHERE id=$1', [event.id]))
      .rows[0].retired_at,
  ).toBeTruthy();
});

test('Calendar year/month navigation, leap-day ranges, event-type filters and exact section filters work together', async ({
  page,
  authAppURL,
  platformApp,
}, testInfo) => {
  const f = platformApp.records;
  const other = await platformApp.request(
    '/resources/classes',
    'POST',
    {
      academic_session_id: f.session,
      grade: '8',
      section: 'FILTER_B',
      class_teacher_id: f.teacherId,
    },
    f.admin,
    f.schoolA,
  );
  for (const [title, kind, ids, start, end] of [
    ['Leap holiday', 'HOLIDAY', [], '2028-02-28', '2028-03-02'],
    ['A activity', 'ACTIVITY', [f.classId], '2028-03-01', '2028-03-01'],
    ['B school event', 'SCHOOL_EVENT', [other.body.id], '2028-03-01', '2028-03-01'],
    ['Important date notice', 'ANNOUNCEMENT', [], '2028-03-01', '2028-03-01'],
  ] as const) {
    const r = await platformApp.request(
      '/calendar/events',
      'POST',
      {
        title,
        description: 'Calendar filter detail',
        kind,
        start_date: start,
        end_date: end,
        audience: ids.length ? 'CLASSES' : 'SCHOOL',
        class_ids: ids,
      },
      f.admin,
      f.schoolA,
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  }
  await page.goto(authAppURL + '/admin/r/school_holidays');
  await expect(page).toHaveURL(/\/admin\/calendar$/);
  await expect(page.getByRole('button', { name: 'Add record', exact: true })).toHaveCount(0);
  await page.getByLabel('Calendar year', { exact: true }).selectOption('2028');
  await expect(page.locator('[data-date]')).toHaveCount(366);
  await expect(page.locator('[data-date="2028-02-29"]')).toHaveAttribute(
    'aria-label',
    /1 event · Holiday/,
  );
  await expect(page.locator('[data-date="2028-03-01"]')).toHaveAttribute(
    'style',
    /linear-gradient/,
  );
  await page
    .getByRole('combobox', { name: 'Class', exact: true })
    .selectOption({ label: 'Class 8 · Test year' });
  await page.getByRole('combobox', { name: 'Section', exact: true }).selectOption(f.classId);
  await expect(page.locator('[data-date="2028-03-01"]')).toHaveAttribute('aria-label', /3 events/);
  await page.getByRole('combobox', { name: 'Event type', exact: true }).selectOption('HOLIDAY');
  await expect(page.locator('[data-date="2028-03-01"]')).toHaveAttribute(
    'aria-label',
    /1 event · Holiday/,
  );
  await page.getByRole('combobox', { name: 'Event type', exact: true }).selectOption('');
  await page.getByRole('combobox', { name: 'Class', exact: true }).selectOption('');
  await page.getByRole('button', { name: 'Previous year', exact: true }).click();
  await expect(page.getByLabel('Calendar year', { exact: true })).toHaveValue('2027');
  await page.getByRole('button', { name: 'Next year', exact: true }).click();
  await page.getByRole('button', { name: 'Month view', exact: true }).click();
  await page.getByLabel('Calendar month', { exact: true }).selectOption('2');
  await page.getByRole('button', { name: 'Previous month', exact: true }).click();
  await expect(page.getByLabel('Calendar month', { exact: true })).toHaveValue('1');
  await expect(page.locator('[data-date]')).toHaveCount(29);
  await page.getByRole('button', { name: 'Next month', exact: true }).click();
  await expect(page.locator('[data-date]')).toHaveCount(31);
  const accessible = await new AxeBuilder({ page }).include('main').analyze();
  expect(
    accessible.violations.filter((v) => ['serious', 'critical'].includes(v.impact || '')),
  ).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `tmp/qa/calendar-month-${testInfo.project.name}.png`,
    fullPage: true,
  });
});

test('Calendar loads all event pages and supports keyboard date selection in the contribution year view', async ({
  page,
  authAppURL,
  platformApp,
}, testInfo) => {
  const f = platformApp.records;
  await platformApp.db.query(
    "INSERT INTO school_holidays(school_id,on_date,kind,label) SELECT $1,'2029-01-01'::date+(n-1),'OTHER','Calendar volume '||n FROM generate_series(1,105) n",
    [f.schoolA],
  );
  await page.goto(authAppURL + '/admin/calendar');
  await page.getByLabel('Calendar year', { exact: true }).selectOption('2029');
  await expect(
    page.getByText('105 events · Select a date for details', { exact: true }),
  ).toBeVisible({ timeout: 30000 });
  await page.locator('[data-date="2029-01-01"]').focus();
  await page.locator('[data-date="2029-01-01"]').press('ArrowRight');
  await expect(page.locator('[data-date="2029-01-08"]')).toBeFocused();
  await page.locator('[data-date="2029-01-08"]').press('Enter');
  await expect(page.getByRole('dialog')).toContainText('Calendar volume 8');
  await page.getByRole('dialog').getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.locator('[data-date="2029-04-15"]').click();
  await expect(page.getByRole('dialog')).toContainText('Calendar volume 105');
  await page.getByRole('dialog').getByRole('button', { name: 'Close dialog', exact: true }).click();
  const accessible = await new AxeBuilder({ page }).include('main').analyze();
  expect(
    accessible.violations.filter((v) => ['serious', 'critical'].includes(v.impact || '')),
  ).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `tmp/qa/calendar-year-${testInfo.project.name}.png`,
    fullPage: true,
  });
});
