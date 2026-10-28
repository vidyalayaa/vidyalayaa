import { expect } from '@playwright/test';
import { test } from './fixtures/fees-role-app';
for (const role of ['parent', 'student', 'principal', 'finance_staff'] as const)
  test.describe(role, () => {
    test.use({ feeRole: role });
    test(
      role === 'student'
        ? 'has no fee section in the student dashboard'
        : 'sees authorized fee records and receipts with correct management permissions',
      async ({ page, authAppURL, platformApp }) => {
        if (role === 'student') {
          await page.goto(authAppURL + '/student/r/fee_records');
          await expect(
            page.getByRole('heading', { name: 'Access unavailable', exact: true }),
          ).toBeVisible();
          await expect(page.locator('a[href="/student/r/fee_records"]')).toHaveCount(0);
          await expect(
            page.getByRole('combobox', { name: 'Academic year', exact: true }),
          ).toHaveCount(0);
          return;
        }
        const f = platformApp.records,
          label = 'Role-visible tuition ' + role,
          fee = (
            await platformApp.db.query<{ id: string }>(
              "INSERT INTO fee_records(school_id,student_id,academic_session_id,class_id,fee_type,amount_due,due_on,status) VALUES($1,$2,$3,$4,$5,100,'2026-01-01','UNPAID') RETURNING id",
              [f.schoolA, f.student, f.session, f.classId, label],
            )
          ).rows[0].id;
        const payment = await platformApp.request(
          '/fees/payments',
          'POST',
          {
            student_id: f.student,
            academic_session_id: f.session,
            payment_date: '2026-01-01',
            payment_method: 'CASH',
            allocations: [{ fee_id: fee, amount: 20 }],
          },
          f.admin,
          f.schoolA,
        );
        // The fixture helper intentionally has no headers argument; submit through its
        // real authenticated API with the required idempotency header instead.
        expect(payment.status).toBe(422);
        const { fixtureToken } = await import('./fixtures/platform-app');
        const response = await fetch(platformApp.url + '/api/v1/fees/payments', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + fixtureToken(f.admin),
            'X-School-Id': f.schoolA,
            'Content-Type': 'application/json',
            'Idempotency-Key': crypto.randomUUID(),
          },
          body: JSON.stringify({
            student_id: f.student,
            academic_session_id: f.session,
            payment_date: '2026-01-01',
            payment_method: 'CASH',
            allocations: [{ fee_id: fee, amount: 20 }],
          }),
        });
        expect(response.status).toBe(201);
        const saved = await response.json();
        await page.goto(
          authAppURL + '/' + (role === 'finance_staff' ? 'finance' : role) + '/r/fee_records',
        );
        await page
          .getByRole('combobox', { name: 'Academic year', exact: true })
          .selectOption(f.session);
        await page.getByRole('combobox', { name: 'Student', exact: true }).selectOption(f.student);
        await expect(page.getByRole('row').filter({ hasText: label })).toContainText('₹80.00');
        await expect(page.getByRole('button', { name: 'Record payment', exact: true })).toHaveCount(
          role === 'finance_staff' ? 1 : 0,
        );
        await expect(
          page.getByRole('button', { name: 'Assign transport', exact: true }),
        ).toHaveCount(role === 'finance_staff' ? 1 : 0);
        const history = page.getByRole('article').filter({ hasText: saved.receipt.receipt_no });
        await history.getByRole('button', { name: 'Receipt', exact: true }).click();
        await expect(page.getByRole('dialog')).toContainText(label);
        await expect(page.getByRole('dialog')).toContainText(saved.receipt.receipt_no);
        await page.getByRole('dialog').getByRole('button', { name: 'Done', exact: true }).click();
        if (role === 'parent') {
          await expect(
            page.getByRole('button', { name: 'Class fee structures', exact: true }),
          ).toHaveCount(0);
          await expect(page.getByRole('button', { name: 'Reverse', exact: true })).toHaveCount(0);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
      },
    );
  });
