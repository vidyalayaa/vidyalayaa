import { expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { test } from './fixtures/timetable-role-app';
import { schoolProfileDetailsSchema, schoolProfileAdminSchema } from '@vidyalayaa/contracts';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
);
test.setTimeout(90000);
test.describe('School Admin', () => {
  test.use({ timetableRole: 'school_admin' });
  test('completes a saved profile, manages images and shared timings, and retains unrelated settings', async ({
    page,
    authAppURL,
    platformApp,
  }, info) => {
    const f = platformApp.records;
    await page.goto(authAppURL + '/admin/school-information');
    await expect(page.getByRole('heading', { name: 'School profile', exact: true })).toBeVisible();
    await expect(
      page.getByRole('progressbar', { name: 'School profile completion', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Edit school profile', exact: true }).click();
    await page.getByLabel('School name', { exact: true }).fill('Connected school profile');
    await page.getByLabel('School email', { exact: false }).fill('office@example.invalid');
    await page.getByLabel('Street address', { exact: false }).fill('Example school road');
    await page.getByLabel('Principal name', { exact: false }).fill('Principal Browser Example');
    await page
      .getByLabel('Management organization', { exact: true })
      .fill('Browser education trust');
    await page
      .getByLabel('Internal policies & management notes', { exact: true })
      .fill('Restricted management note');
    await page.getByLabel('Library', { exact: true }).check();
    await page.getByRole('button', { name: 'Save profile', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Edit school profile', exact: true }),
    ).toBeVisible();
    await expect(page.locator('.school-selector strong')).toHaveText('Connected school profile');
    await page
      .getByLabel('File title / image description', { exact: true })
      .fill('Browser school logo');
    await page
      .getByLabel('Choose file', { exact: true })
      .setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: png });
    await page.getByRole('button', { name: 'Upload file', exact: true }).click();
    await expect(page.getByRole('img', { name: 'Browser school logo', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Manage school timings', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Save school timings', exact: true })
      .click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(
      (await platformApp.request('/timetable/settings', 'GET', undefined, f.admin, f.schoolA)).body
        .configured,
    ).toBe(true);
    await page.screenshot({ path: info.outputPath('school-profile.png'), fullPage: true });
    const audit = await new AxeBuilder({ page }).include('main').analyze();
    expect(
      audit.violations.filter((v) => ['critical', 'serious'].includes(v.impact || '')),
    ).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Remove Browser school logo', exact: true }).click();
    await expect(page.getByRole('img', { name: 'Browser school logo', exact: true })).toHaveCount(
      0,
    );
  });
});
for (const role of ['principal', 'teacher', 'parent', 'student'] as const)
  test.describe(role, () => {
    test.use({ timetableRole: role });
    test('shows current school information with role-appropriate privacy and no editing controls', async ({
      page,
      authAppURL,
      platformApp,
    }) => {
      const f = platformApp.records;
      await platformApp.db.query('UPDATE schools SET profile=$2 WHERE id=$1', [
        f.schoolA,
        schoolProfileDetailsSchema.parse({
          about: 'School profile visible information',
          phone: '+91 9999999999',
          city: 'Visible city',
          principal_name: 'Official Principal',
          facilities: ['Library', 'Sports ground'],
        }),
      ]);
      await platformApp.db.query(
        'INSERT INTO school_profile_private(school_id,details) VALUES($1,$2) ON CONFLICT(school_id) DO UPDATE SET details=excluded.details,principal_edit_authorized=false',
        [
          f.schoolA,
          schoolProfileAdminSchema.parse({
            management_name: 'Restricted education trust',
            internal_policies: 'Restricted policy information',
          }),
        ],
      );
      await page.goto(authAppURL + `/${role}/school-information`);
      await expect(
        page.getByRole('heading', { name: 'School information', exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText('School profile visible information', { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Edit school profile', exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: 'Manage school timings', exact: true }),
      ).toHaveCount(0);
      await expect(page.getByText('Restricted policy information', { exact: true })).toHaveCount(
        role === 'principal' ? 1 : 0,
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    });
  });
test.describe('Super Admin', () => {
  test.use({ timetableRole: 'super_admin' });
  test('opens and edits a registered school profile from the platform console', async ({
    page,
    authAppURL,
    platformApp,
  }) => {
    const f = platformApp.records;
    await page.goto(authAppURL + '/platform/schools');
    await page.locator(`a[href="/platform/schools/${f.schoolA}/profile"]`).click();
    await expect(page).toHaveURL(new RegExp(`/platform/schools/${f.schoolA}/profile$`));
    await page.getByRole('button', { name: 'Edit school profile', exact: true }).click();
    await page
      .getByLabel('About the school', { exact: false })
      .fill('Platform managed school profile');
    await page.getByRole('button', { name: 'Save profile', exact: true }).click();
    await expect(page.getByText('Platform managed school profile', { exact: true })).toBeVisible();
    expect(
      (await platformApp.db.query('SELECT profile FROM schools WHERE id=$1', [f.schoolA])).rows[0]
        .profile.about,
    ).toBe('Platform managed school profile');
  });
});
