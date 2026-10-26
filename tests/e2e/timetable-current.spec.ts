import { expect } from '@playwright/test';
import { test as base } from './fixtures/timetable-role-app';
import { saveTimingTemplate, timetableAdmin, timetableSection } from './fixtures/timetable-data';
import type { PlatformApp } from './fixtures/platform-app';
const test = base.extend<{}, { liveTimetableIsolation: void }>({
  liveTimetableIsolation: [
    async ({}, use) => {
      await use();
    },
    { scope: 'worker', auto: true },
  ],
});
test.use({ timezoneId: 'America/Los_Angeles' });
test.setTimeout(120000);
const seeded = new WeakMap<
  object,
  Promise<{
    first: string;
    other: string;
    third: string;
    mine: string;
    privateId: string;
    mineClass: string;
  }>
>();
function scenario(p: PlatformApp) {
  let setup = seeded.get(p);
  if (!setup) {
    setup = (async () => {
      const f = p.records,
        call = timetableAdmin(p);
      await saveTimingTemplate(p);
      const co = (
        await call('/resources/teachers', 'POST', {
          staff_code: 'LIVE_CO',
          full_name: 'Co-teacher live',
        })
      ).body.id;
      const sub = (
        await call('/resources/subjects', 'POST', { code: 'LIVE_EN', name: 'English live' })
      ).body.id;
      const mineClass = await timetableSection(p, 'LIVE_MY', true),
        hidden = await timetableSection(p, 'LIVE_PRIVATE');
      expect(
        (
          await call('/resources/teacher_class_assignments', 'POST', {
            teacher_id: co,
            class_id: f.classId,
            subject_id: sub,
            starts_on: '2026-01-01',
          })
        ).status,
      ).toBe(201);
      async function create(values: Record<string, unknown>) {
        const r = await call('/resources/timetable_entries', 'POST', {
          class_id: f.classId,
          subject_id: f.subject,
          teacher_id: f.teacherId,
          weekday: 1,
          starts_at: '08:00',
          ends_at: '08:45',
          ...values,
        });
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        return r.body.id as string;
      }
      return {
        first: await create({}),
        other: await create({
          subject_id: sub,
          teacher_id: co,
          starts_at: '08:45',
          ends_at: '09:30',
        }),
        third: await create({ starts_at: '09:45', ends_at: '10:30' }),
        mine: await create({ class_id: mineClass.classId, starts_at: '08:45', ends_at: '09:30' }),
        privateId: await create({
          class_id: hidden.classId,
          teacher_id: hidden.teacherId,
          weekday: 2,
        }),
        mineClass: mineClass.classId,
      };
    })();
    seeded.set(p, setup);
  }
  return setup;
}
async function controlledClock(page: import('@playwright/test').Page) {
  // Skew the device wall clock without freezing React Query's delivery timers.
  await page.clock.setFixedTime(new Date('2026-10-26T10:00:00Z'));
  await page.addInitScript(() => sessionStorage.setItem('vidyalayaa_splash_shown', '1'));
  let anchor = Date.parse('2026-10-26T02:29:00Z'),
    perf: number | undefined;
  await page.route(/\/api\/v1\/.*timetable\/clock(?:\?|$)/, async (route) => {
    const now = await page.evaluate(() => performance.now());
    if (perf === undefined) perf = now;
    await route.fulfill({
      json: { server_time: new Date(anchor + now - perf).toISOString(), timezone: 'Asia/Kolkata' },
    });
  });
  return async (iso: string, time: string) => {
    anchor = Date.parse(iso);
    perf = undefined;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByRole('timer', { name: 'School local time' })).toContainText(time);
  };
}
for (const role of [
  'school_admin',
  'principal',
  'teacher',
  'student',
  'parent',
  'super_admin',
] as const)
  test.describe(role + ' current lecture', () => {
    test.use({ timetableRole: role });
    test('updates highlights at actual lecture boundaries, across breaks and weekdays using school time', async ({
      page,
      authAppURL,
      platformApp,
    }) => {
      const data = await scenario(platformApp),
        setClock = await controlledClock(page),
        portal = role === 'school_admin' || role === 'super_admin' ? 'admin' : role;
      await page.goto(authAppURL + '/' + portal + '/r/timetable_entries');
      await page
        .getByRole('combobox', { name: 'Class and section', exact: true })
        .selectOption(platformApp.records.classId);
      const first = page.locator(`[data-lecture-id="${data.first}"]`),
        other = page.locator(`[data-lecture-id="${data.other}"]`),
        third = page.locator(`[data-lecture-id="${data.third}"]`);
      await expect(other).toContainText('Co-teacher live');
      await setClock('2026-10-26T02:29:59Z', '07:59:59');
      await expect(first).toHaveAttribute('data-current-lecture', 'false');
      await expect(first).toHaveAttribute('data-current-lecture', 'true');
      await expect(first).toHaveClass(/border-lime-500/);
      await expect(first).toHaveClass(/bg-lime-100/);
      await expect(first).toContainText('In progress');
      await setClock('2026-10-26T03:14:59Z', '08:44:59');
      await expect(first).toHaveAttribute('data-current-lecture', 'false');
      await expect(other).toHaveAttribute('data-current-lecture', 'true');
      await setClock('2026-10-26T04:00:00Z', '09:30:00');
      await expect(page.locator('[data-current-lecture="true"]')).toHaveCount(0);
      await setClock('2026-10-26T04:14:59Z', '09:44:59');
      await expect(third).toHaveAttribute('data-current-lecture', 'true');
      await setClock('2026-10-26T05:00:00Z', '10:30:00');
      await expect(page.locator('[data-current-lecture="true"]')).toHaveCount(0);
      await setClock('2026-10-27T02:40:00Z', '08:10:00');
      await expect(page.locator('[data-current-lecture="true"]')).toHaveCount(0);
      if (['teacher', 'student', 'parent', 'principal'].includes(role))
        await expect(page.getByRole('button', { name: 'School timings', exact: true })).toHaveCount(
          0,
        );
    });
  });
test.describe('teacher combined timetable', () => {
  test.use({ timetableRole: 'teacher' });
  test('shows all own lectures across classes, preserves full class view and denies unrelated classes', async ({
    page,
    authAppURL,
    platformApp,
  }) => {
    const data = await scenario(platformApp),
      setClock = await controlledClock(page);
    await page.goto(authAppURL + '/teacher/r/timetable_entries');
    await page
      .getByRole('combobox', { name: 'Class and section', exact: true })
      .selectOption(platformApp.records.classId);
    await expect(page.locator(`[data-lecture-id="${data.other}"]`)).toContainText('English live');
    await page.getByRole('tab', { name: 'My Timetable', exact: true }).click();
    const grid = page.getByRole('region', { name: 'Weekly teacher timetable', exact: true });
    await expect(grid).toBeVisible();
    await expect(grid.locator(`[data-lecture-id="${data.first}"]`)).toBeVisible();
    await expect(grid.locator(`[data-lecture-id="${data.third}"]`)).toBeVisible();
    await expect(grid.locator(`[data-lecture-id="${data.mine}"]`)).toContainText(
      'Class 9 · Section TT_LIVE_MY',
    );
    await expect(grid.locator(`[data-lecture-id="${data.other}"]`)).toHaveCount(0);
    await expect(grid.locator(`[data-lecture-id="${data.privateId}"]`)).toHaveCount(0);
    await setClock('2026-10-26T03:20:00Z', '08:50:00');
    await expect(grid.locator(`[data-lecture-id="${data.mine}"]`)).toHaveAttribute(
      'data-current-lecture',
      'true',
    );
    await page.getByRole('tab', { name: 'Class Timetable', exact: true }).click();
    await expect(page.locator(`[data-lecture-id="${data.other}"]`)).toHaveAttribute(
      'data-current-lecture',
      'true',
    );
    await expect(
      page.getByRole('button', { name: /Add lecture|Edit lecture|Delete lecture/ }),
    ).toHaveCount(0);
  });
});
