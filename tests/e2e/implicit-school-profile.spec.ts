import { expect } from '@playwright/test';
import { test } from './fixtures/school-admin-app';

test.use({ implicitSchool: true });
test.setTimeout(90000);

test('single-school default saves profiles, files and timings without falsely reporting a context change', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  const f = platformApp.records;
  const writes: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (
      path.includes('/api/v1/school-profile') &&
      ['PUT', 'POST', 'DELETE'].includes(request.method())
    ) {
      expect(request.headers()['x-school-id']).toBeUndefined();
      writes.push(request.method() + ' ' + path);
    }
  });
  await page.goto(authAppURL + '/admin/school-information');
  await expect(
    page.getByRole('button', { name: 'Edit school profile', exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('vidyalayaa.school'))).toBe('');
  await page.getByRole('button', { name: 'Edit school profile', exact: true }).click();
  await page
    .getByLabel('Street address', { exact: false })
    .fill('Saved with the automatically selected school');
  await page.getByRole('button', { name: 'Save profile', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Edit school profile', exact: true }),
  ).toBeVisible();
  expect(
    (await platformApp.db.query('SELECT profile FROM schools WHERE id=$1', [f.schoolA])).rows[0]
      .profile.address_line1,
  ).toBe('Saved with the automatically selected school');
  await page
    .getByLabel('File title / image description', { exact: true })
    .fill('Implicit-school logo');
  await page
    .getByLabel('Choose file', { exact: true })
    .setInputFiles({
      name: 'logo.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
        'base64',
      ),
    });
  await page.getByRole('button', { name: 'Upload file', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Implicit-school logo', exact: true })).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Remove Implicit-school logo', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Implicit-school logo', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Manage school timings', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Save school timings', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(writes.some((p) => p === 'PUT /api/v1/school-profile')).toBe(true);
  expect(writes.some((p) => p === 'POST /api/v1/school-profile/assets')).toBe(true);
  expect(writes.some((p) => p.startsWith('DELETE /api/v1/school-profile/assets/'))).toBe(true);
  expect(writes.some((p) => p === 'PUT /api/v1/school-profile/timings')).toBe(true);
  expect(await page.evaluate(() => sessionStorage.getItem('vidyalayaa.school'))).toBe('');
});
