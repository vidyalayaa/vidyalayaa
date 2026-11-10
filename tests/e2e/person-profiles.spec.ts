import { expect } from '@playwright/test';
import { test } from './fixtures/school-admin-app';
import sharp from 'sharp';

test.use({ implicitSchool: true });
test.setTimeout(120000);

test('School Admin saves and removes a cropped staff photograph in an automatically selected school', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  const staff = platformApp.records.teacherId;
  const portrait = await sharp({
    create: { width: 120, height: 150, channels: 3, background: '#88cc00' },
  })
    .png()
    .toBuffer();
  await page.goto(authAppURL + '/admin/r/teachers');
  expect(await page.evaluate(() => sessionStorage.getItem('vidyalayaa.school'))).toBe('');
  await page
    .getByRole('row')
    .filter({ hasText: 'Teacher Test' })
    .getByRole('button', { name: 'View', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Staff profile' });
  await expect(dialog).toContainText('Mathematics');
  await dialog.getByRole('button', { name: 'Manage photo' }).click();
  await dialog
    .getByLabel('Choose a photo')
    .setInputFiles({ name: 'portrait.png', mimeType: 'image/png', buffer: portrait });
  await expect(dialog.getByRole('img', { name: 'Cropped photo preview' })).toBeVisible();
  const layout = await dialog.evaluate((element) => {
    const frame = element.getBoundingClientRect();
    const editor = element.querySelector('fieldset')!.getBoundingClientRect();
    const details = element.querySelector('section')!.getBoundingClientRect();
    return {
      viewport: innerWidth,
      width: frame.width,
      editorX: editor.x,
      editorRight: editor.right,
      detailsX: details.x,
    };
  });
  if (layout.viewport >= 1024) {
    expect(layout.width).toBeGreaterThan(900);
    expect(layout.detailsX).toBeGreaterThan(layout.editorRight);
  } else {
    expect(layout.width).toBeLessThan(layout.viewport);
    expect(layout.detailsX).toBeCloseTo(layout.editorX);
  }
  await dialog.getByRole('slider', { name: 'Zoom' }).focus();
  await page.keyboard.press('ArrowRight');
  const photoRequests: { method: string; school?: string }[] = [];
  page.on('request', (req) => {
    if (req.url().endsWith(`/api/v1/profiles/staff/${staff}/photo`))
      photoRequests.push({ method: req.method(), school: req.headers()['x-school-id'] });
  });
  await dialog.getByRole('button', { name: 'Save cropped photo' }).click();
  await expect(dialog.getByRole('status')).toContainText('Profile photo saved.');
  await expect(dialog.getByRole('img', { name: 'Teacher Test profile photo' })).toBeVisible();
  const ref = async () =>
    (
      await platformApp.db.query<{ profile_photo_id: string | null }>(
        'SELECT profile_photo_id FROM teachers WHERE id=$1',
        [staff],
      )
    ).rows[0].profile_photo_id;
  const stored = await ref();
  expect(stored).toBeTruthy();
  const path = `${platformApp.records.schoolA}/profiles/staff/${staff}/${stored}.jpg`;
  expect(platformApp.objects.has(path)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await dialog.getByRole('button', { name: 'Remove photo', exact: true }).click();
  await dialog.getByRole('button', { name: 'Confirm remove' }).click();
  await expect(dialog.getByRole('status')).toContainText('Profile photo removed.');
  await expect(dialog.getByRole('button', { name: 'Close dialog' })).toBeInViewport();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(photoRequests).toEqual([{ method: 'PUT' }, { method: 'DELETE' }]);
  expect(await ref()).toBeNull();
  expect(platformApp.objects.has(path)).toBe(false);
});

test('School Admin reviews ZIP matches, selects a manual match and confirms an existing photo replacement', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  const id = platformApp.records.student;
  const revision = '81a043bc-6d21-43b7-8300-00a934a38861';
  const student = { id, code: 'STU001', name: 'Test learner', photo_id: revision };
  await page.route('**/api/v1/profiles/student/photos/preview', (route) =>
    route.fulfill({
      json: {
        archive_hash: '1'.repeat(64),
        candidates: [],
        missing: 3,
        photos: [{ index: 0, filename: 'unknown.png', code: 'unknown', duplicate: false }],
      },
    }),
  );
  await page.route('**/api/v1/profiles/student/candidates?**', (route) =>
    route.fulfill({
      json: { data: [student], page: 1, page_size: 10, total: 1 },
    }),
  );
  await page.route('**/api/v1/profiles/student/photos/import', async (route) => {
    const manifest = route.request().postDataBuffer()?.toString() || '';
    expect(manifest).toContain(`"person_id":"${id}"`);
    expect(manifest).toContain(`"expected_photo_id":"${revision}"`);
    expect(manifest).toContain('"replace":true');
    await route.fulfill({ json: { saved: 1, failed: [], missing: 3 } });
  });
  await page.goto(authAppURL + '/admin/r/students');
  await page.getByRole('button', { name: 'Import photo ZIP' }).click();
  const dialog = page.getByRole('dialog', { name: 'Import profile photos' });
  await dialog.getByLabel('Photo ZIP file').setInputFiles({
    name: 'photos.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from('fixture'),
  });
  await dialog.getByRole('button', { name: 'Preview ZIP' }).click();
  await expect(dialog.getByRole('status')).toContainText('1 unmatched');
  await dialog.getByRole('button', { name: 'Match unknown.png manually' }).click();
  await dialog.getByRole('button', { name: 'Match to Test learner (STU001)' }).click();
  const confirm = dialog.getByRole('checkbox', { name: 'Replace existing photo for Test learner' });
  const importButton = dialog.getByRole('button', { name: 'Import 1 matched photos' });
  await expect(importButton).toBeDisabled();
  await confirm.check();
  await importButton.click();
  await expect(dialog.getByRole('status')).toContainText('1 photos saved · 0 failed');
});

test('School Admin saves staff details and previews Excel with an automatically selected school', async ({
  page,
  authAppURL,
  platformApp,
}) => {
  await page.route('**/api/v1/profiles/staff/workbook', (route) => {
    expect(route.request().headers()['x-school-id']).toBeUndefined();
    return route.fulfill({ json: { csv: 'staff_code,full_name\r\n0007,Imported Staff' } });
  });
  await page.goto(authAppURL + '/admin/r/teachers');
  await page
    .getByRole('row')
    .filter({ hasText: 'Teacher Test' })
    .getByRole('button', { name: 'View', exact: true })
    .click();
  const profile = page.getByRole('dialog', { name: 'Staff profile' });
  await profile.getByRole('button', { name: 'Edit profile details' }).click();
  await profile.getByRole('textbox', { name: 'Designation', exact: true }).fill('Senior teacher');
  await profile.getByRole('button', { name: 'Save profile details' }).click();
  await expect(profile.getByText('Senior teacher', { exact: true })).toBeVisible();
  const { rows } = await platformApp.db.query<{ details: { designation: string } }>(
    'SELECT details FROM school_person_details WHERE school_id=$1 AND staff_id=$2',
    [platformApp.records.schoolA, platformApp.records.teacherId],
  );
  expect(rows[0]?.details.designation).toBe('Senior teacher');
  await profile.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'Import CSV', exact: true }).click();
  const importing = page.getByRole('dialog', { name: 'Import school records' });
  await importing.getByLabel('CSV or Excel file').setInputFiles({
    name: 'staff.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from('fixture'),
  });
  await expect(importing.getByRole('textbox', { name: 'CSV preview' })).toHaveValue(
    'staff_code,full_name\n0007,Imported Staff',
  );
});
