import { expect } from '@playwright/test';
import { test } from './fixtures/timetable-role-app';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7u0AAAAASUVORK5CYII=',
  'base64',
);
for (const role of ['school_admin', 'teacher', 'student', 'parent'] as const) {
  test.describe(role, () => {
    test.use({ timetableRole: role });
    test('subject materials can be shared by authorized staff and opened/downloaded by families', async ({
      page,
      authAppURL,
      platformApp,
    }, testInfo) => {
      test.setTimeout(120000);
      const f = platformApp.records,
        title = `${role} subject notes`,
        name = `${role}-notes.png`;
      const canWrite = role === 'school_admin' || role === 'teacher';
      if (canWrite) {
        await page.route(
          'https://mfa-qr.test/storage/v1/object/upload/sign/school-documents/**',
          async (route) => {
            const path = decodeURIComponent(
              new URL(route.request().url()).pathname.split('/school-documents/')[1],
            );
            platformApp.objects.set(path, png);
            await route.fulfill({ json: { Key: 'school-documents/' + path } });
          },
        );
      } else {
        const ticket = await platformApp.request(
          '/materials/upload',
          'POST',
          { class_id: f.classId, subject_id: f.subject, filename: name },
          f.admin,
          f.schoolA,
        );
        expect(ticket.status).toBe(200);
        platformApp.objects.set(ticket.body.path, png);
        const created = await platformApp.request(
          '/resources/assignments',
          'POST',
          {
            class_id: f.classId,
            subject_id: f.subject,
            kind: 'MATERIAL',
            title,
            body: 'Shared notes for this subject.',
            storage_path: ticket.body.path,
          },
          f.admin,
          f.schoolA,
        );
        expect(created.status).toBe(201);
      }
      if (role === 'school_admin') {
        await page.goto(authAppURL + '/admin/academics');
        const section = page
          .locator('details')
          .filter({ has: page.locator('summary').filter({ hasText: 'Section A' }) })
          .first();
        await section.locator('summary').click();
        await section
          .getByRole('article', { name: 'Subject Mathematics', exact: true })
          .getByRole('button', { name: 'Study materials', exact: true })
          .click();
      } else if (role === 'teacher') {
        await page.goto(authAppURL + '/teacher/materials');
        await page
          .getByLabel('Assigned class and section', { exact: true })
          .selectOption(f.classId);
        await page.getByRole('button', { name: /Mathematics.*Manage study materials/ }).click();
      } else {
        await page.goto(authAppURL + `/${role}/r/classes`);
        if (role === 'parent')
          await page.getByLabel('Your child', { exact: true }).selectOption(f.student);
        await page.getByRole('button', { name: /Mathematics.*View study materials/ }).click();
      }
      const dialog = page.getByRole('dialog', {
        name: 'Mathematics · Study materials',
        exact: true,
      });
      if (canWrite) {
        await dialog.getByRole('button', { name: 'Add study material', exact: true }).click();
        await dialog.getByLabel('Material title', { exact: true }).fill(title);
        await dialog
          .getByLabel('Notes or description', { exact: true })
          .fill('Shared notes for this subject.');
        await dialog
          .getByLabel('Material file', { exact: true })
          .setInputFiles({ name, mimeType: 'image/png', buffer: png });
        await dialog.getByRole('button', { name: 'Save material', exact: true }).click();
      } else {
        await expect(
          dialog.getByRole('button', { name: /Add study material|Edit material|Archive material/ }),
        ).toHaveCount(0);
      }
      const card = dialog
        .getByRole('article')
        .filter({ has: page.getByRole('heading', { name: title, exact: true }) });
      await expect(card).toContainText('Shared notes for this subject.');
      await card.getByRole('button', { name: 'Open material', exact: true }).click();
      await expect(dialog.getByRole('img')).toBeVisible();
      expect(
        await dialog.getByRole('img').evaluate((img: HTMLImageElement) => img.naturalWidth),
      ).toBe(1);
      const downloaded = page.waitForEvent('download');
      await card.getByRole('button', { name: 'Download material', exact: true }).click();
      expect((await downloaded).suggestedFilename()).toContain(name);
      await page.screenshot({ path: testInfo.outputPath('subject-materials.png'), fullPage: true });
      if (canWrite) {
        await card.getByRole('button', { name: 'Edit material', exact: true }).click();
        await dialog.getByLabel('Material title', { exact: true }).fill(title + ' updated');
        await dialog.getByRole('button', { name: 'Save material', exact: true }).click();
        await expect(
          dialog.getByRole('heading', { name: title + ' updated', exact: true }),
        ).toBeVisible();
        page.once('dialog', (d) => d.accept());
        await dialog
          .getByRole('article')
          .filter({ hasText: title + ' updated' })
          .getByRole('button', { name: 'Archive material', exact: true })
          .click();
        await expect(
          dialog.getByRole('heading', { name: title + ' updated', exact: true }),
        ).toHaveCount(0);
      }
    });
  });
}
