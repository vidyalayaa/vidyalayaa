import { beforeAll, afterAll, it, expect } from 'vitest';
import request from 'supertest';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { portableDatabase, poolAdapters, fixture } from '../helpers/database.js';
import { createApp } from '../../apps/api/src/app.js';
import { transaction } from '../../apps/api/src/lib/db.js';
import type { Config } from '../../apps/api/src/lib/config.js';
let db: PGlite,
  f: Awaited<ReturnType<typeof fixture>>,
  app: ReturnType<typeof createApp>,
  sectionB: string,
  secondStudent: string,
  finance: string,
  routeId: string;
const call = (method: 'get' | 'post' | 'patch', path: string, role = 'admin') =>
  request(app)
    [method]('/api/v1' + path)
    .set('Authorization', 'Bearer ' + role)
    .set('X-School-Id', f.schoolA);
const collect = (fees: { id: string; amount: number }[], extra: Record<string, unknown> = {}) => ({
  student_id: f.student,
  academic_session_id: f.session,
  payment_date: '2026-01-01',
  payment_method: 'CASH',
  allocations: fees.map((x) => ({ fee_id: x.id, amount: x.amount })),
  ...extra,
});
const pay = (body: unknown, key = crypto.randomUUID(), role = 'admin') =>
  call('post', '/fees/payments', role).set('Idempotency-Key', key).send(body);
async function assessment(amount = 100, student = f.student) {
  return (
    await db.query<{ id: string }>(
      "INSERT INTO fee_records(school_id,student_id,academic_session_id,class_id,fee_type,amount_due,due_on,status) VALUES($1,$2,$3,$4,'Test fee', $5,'2026-01-01','UNPAID') RETURNING id",
      [f.schoolA, student, f.session, f.classId, amount],
    )
  ).rows[0].id;
}
beforeAll(async () => {
  db = await portableDatabase();
  f = await fixture(db);
  finance = crypto.randomUUID();
  await db.query('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3)', [
    finance,
    finance + '@example.invalid',
    { full_name: 'Finance Test' },
  ]);
  await db.query(
    "INSERT INTO school_memberships(school_id,user_id,role_id) SELECT $1,$2,id FROM roles WHERE code='finance_staff'",
    [f.schoolA, finance],
  );
  await db.query(
    "INSERT INTO teachers(school_id,user_id,staff_code,full_name,staff_role) VALUES($1,$2,'FIN','Finance Test','finance_staff')",
    [f.schoolA, finance],
  );
  sectionB = crypto.randomUUID();
  secondStudent = crypto.randomUUID();
  await db.query(
    "INSERT INTO classes(id,school_id,academic_session_id,grade,section) VALUES($1,$2,$3,'8','B')",
    [sectionB, f.schoolA, f.session],
  );
  await db.query(
    "INSERT INTO students(id,school_id,student_code,first_name) VALUES($1,$2,'FEE002','Second learner')",
    [secondStudent, f.schoolA],
  );
  await db.query(
    "INSERT INTO enrollments(school_id,student_id,class_id,academic_session_id,starts_on) VALUES($1,$2,$3,$4,'2026-01-01')",
    [f.schoolA, secondStudent, sectionB, f.session],
  );
  const ids: Record<string, string> = {
    admin: f.admin,
    parent: f.parent,
    student: f.studentUser,
    teacher: f.teacher,
    principal: f.principal,
    finance,
  };
  const supabase = {
    auth: {
      getUser: async (token: string) => ({ data: { user: { id: ids[token] } }, error: null }),
    },
  } as unknown as SupabaseClient;
  app = createApp(
    {
      NODE_ENV: 'test',
      WEB_ORIGINS: 'http://localhost:5173',
      TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32),
      TRUST_PROXY_HOPS: 0,
    } as Config,
    { ...poolAdapters(db), supabase },
  );
});
afterAll(async () => db.close());
it('preserves approved time-limited support reads only for an explicit fees scope', async () => {
  const root = crypto.randomUUID();
  await db.query('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3)', [
    root,
    root + '@example.invalid',
    { full_name: 'Support Test' },
  ]);
  await db.query("INSERT INTO platform_staff(user_id,platform_role) VALUES($1,'SUPER_ADMIN')", [
    root,
  ]);
  const id = await assessment(),
    grant = (
      await db.query<{ id: string }>(
        "INSERT INTO support_access_grants(school_id,staff_user_id,reason,ticket_ref,scope,approved_by,starts_at,expires_at) VALUES($1,$2,'Approved fee support review','FEE-TEST','[\"fees\"]',$3,now(),now()+interval '1 hour') RETURNING id",
        [f.schoolA, root, f.admin],
      )
    ).rows[0].id;
  const read = () =>
    transaction(
      poolAdapters(db).api,
      { schoolId: f.schoolA, userId: root, actorType: 'SUPPORT' },
      async (tx) => (await tx.query('SELECT id FROM fee_records WHERE id=$1', [id])).rows,
    );
  expect(await read()).toHaveLength(1);
  await db.query('UPDATE support_access_grants SET scope=\'["students"]\' WHERE id=$1', [grant]);
  expect(await read()).toHaveLength(0);
  await db.query(
    'UPDATE support_access_grants SET scope=\'["fees"]\',revoked_at=now() WHERE id=$1',
    [grant],
  );
  expect(await read()).toHaveLength(0);
});
it('binds finance invitations to an existing active finance staff record', async () => {
  const record = (
    await db.query<{ id: string }>(
      "INSERT INTO teachers(school_id,staff_code,full_name,staff_role,email) VALUES($1,'FIN-INVITE','New finance staff','finance_staff','finance-new@example.invalid') RETURNING id",
      [f.schoolA],
    )
  ).rows[0].id;
  const intent = await transaction(
    poolAdapters(db).api,
    { schoolId: f.schoolA, userId: f.admin },
    async (tx) =>
      (
        await tx.query(
          "SELECT app.begin_school_invitation($1,'finance-new@example.invalid','New finance staff','finance_staff',false,$2) AS result",
          [f.schoolA, record],
        )
      ).rows[0].result,
  );
  expect(intent.action).toBe('send');
  expect(
    (await db.query('SELECT teacher_id,role_code FROM school_invitations WHERE id=$1', [intent.id]))
      .rows[0],
  ).toEqual({ teacher_id: record, role_code: 'finance_staff' });
  expect(
    (
      await call('post', '/invitations', 'finance').send({
        role: 'finance_staff',
        record_id: record,
        email: 'finance-new@example.invalid',
        full_name: 'New finance staff',
      })
    ).status,
  ).toBe(403);
});
it('configures class-wide and section-specific fee versions without rewriting assessed history', async () => {
  const body = {
    academic_session_id: f.session,
    grade: '8',
    mode: 'SAME',
    expected_version: 0,
    items: [
      {
        class_id: null,
        category: 'TUITION',
        label: 'Class tuition',
        amount: 100,
        frequency: 'ONE_TIME',
        first_due_on: '2026-01-01',
      },
    ],
  };
  const st = await call('post', '/fees/structures').send(body);
  expect(st.status, st.text).toBe(201);
  const structures = await call('get', `/fees/structures?academic_session_id=${f.session}&grade=8`);
  expect(structures.body.data[0].class_ids).toHaveLength(2);
  for (const [class_id, student_id] of [
    [f.classId, f.student],
    [sectionB, secondStudent],
  ]) {
    const input = { structure_id: st.body.id, class_id, student_id };
    expect((await call('post', '/fees/assessments/preview').send(input)).body).toMatchObject({
      installments: 1,
      amount: '100.00',
    });
    const saved = await call('post', '/fees/assessments').send(input);
    expect(saved.status, saved.text).toBe(200);
    expect(saved.body.created).toBe(1);
    expect((await call('post', '/fees/assessments').send(input)).body.created).toBe(0);
  }
  const next = await call('post', '/fees/structures').send({
    ...body,
    expected_version: 1,
    mode: 'SECTION',
    items: [
      { ...body.items[0], class_id: f.classId, amount: 150 },
      { ...body.items[0], class_id: sectionB, amount: 200 },
    ],
  });
  expect(next.status, next.text).toBe(201);
  expect(
    (
      await call('post', '/fees/assessments').send({
        structure_id: next.body.id,
        class_id: f.classId,
      })
    ).body.created,
  ).toBe(0);
  expect(
    (
      await db.query<{ amount_due: string }>(
        "SELECT amount_due FROM fee_records WHERE student_id=$1 AND fee_type='Class tuition'",
        [f.student],
      )
    ).rows[0].amount_due,
  ).toBe('100.00');
  expect(
    (await call('post', '/fees/structures').send({ ...body, expected_version: 1 })).status,
  ).toBe(409);
  expect(
    (
      await call('post', '/fees/structures').send({
        ...body,
        expected_version: 2,
        mode: 'SECTION',
        items: [{ ...body.items[0], class_id: f.classId }],
      })
    ).status,
  ).toBe(422);
});
it('voids an unpaid assessment and explicitly reassesses a corrected version without erasing history', async () => {
  const old = (
    await db.query<{ id: string }>(
      "SELECT id FROM fee_records WHERE student_id=$1 AND fee_type='Class tuition' AND voided_at IS NULL",
      [f.student],
    )
  ).rows[0];
  expect(
    (
      await call('post', `/fees/assessments/${old.id}/void`).send({
        reason: 'Approved correction to the published fee rate',
      })
    ).status,
  ).toBe(200);
  const latest = (await call('get', `/fees/structures?academic_session_id=${f.session}&grade=8`))
      .body.data[0],
    input = { structure_id: latest.id, class_id: f.classId, student_id: f.student };
  expect((await call('post', '/fees/assessments/preview').send(input)).body).toMatchObject({
    installments: 1,
    amount: '150.00',
  });
  expect((await call('post', '/fees/assessments').send(input)).body.created).toBe(1);
  const rows = (
    await db.query<{ amount_due: string; status: string }>(
      "SELECT amount_due,status FROM fee_records WHERE student_id=$1 AND fee_type='Class tuition' ORDER BY amount_due",
      [f.student],
    )
  ).rows;
  expect(rows).toEqual([
    { amount_due: '100.00', status: 'WAIVED' },
    { amount_due: '150.00', status: 'UNPAID' },
  ]);
});
it('keeps exact cents, receipt snapshots and durable idempotency after generic retry cleanup', async () => {
  const id = await assessment(100.01),
    key = crypto.randomUUID(),
    body = collect([{ id, amount: 40.01 }]);
  const first = await pay(body, key);
  expect(first.status, first.text).toBe(201);
  expect(first.body.receipt).toMatchObject({
    amount: '40.01',
    school_name: 'Test School A',
    student_code: 'STU001',
    recorded_by: 'school_admin Test',
  });
  const retry = await pay(body, key);
  expect(retry.body).toEqual(first.body);
  await db.query('DELETE FROM api_idempotency_keys WHERE school_id=$1', [f.schoolA]);
  expect((await pay(body, key)).body).toEqual(first.body);
  expect((await pay(collect([{ id, amount: 1 }]), key)).status).toBe(409);
  expect((await pay(collect([{ id, amount: 61 }]))).status).toBe(409);
  expect((await pay(collect([{ id, amount: 0.001 }]))).status).toBe(422);
  const row = (
    await db.query<{ amount_paid: string; status: string }>(
      'SELECT amount_paid,status FROM fee_records WHERE id=$1',
      [id],
    )
  ).rows[0];
  expect(row).toEqual({ amount_paid: '40.01', status: 'PARTIAL' });
});
it('prevents duplicate receipt numbers and validates transaction references, payment date and allocation ownership', async () => {
  const one = await assessment(),
    two = await assessment(),
    other = await assessment(100, secondStudent);
  expect(
    (await pay(collect([{ id: one, amount: 10 }], { receipt_no: 'CUSTOM-FEE-001' }))).status,
  ).toBe(201);
  expect(
    (await pay(collect([{ id: two, amount: 10 }], { receipt_no: 'custom-fee-001' }))).status,
  ).toBe(409);
  expect((await pay(collect([{ id: two, amount: 10 }], { payment_method: 'UPI' }))).status).toBe(
    422,
  );
  expect(
    (await pay(collect([{ id: two, amount: 10 }], { payment_date: '2099-01-01' }))).status,
  ).toBe(422);
  expect((await pay(collect([{ id: other, amount: 10 }]))).status).toBe(422);
  expect(
    (
      await pay(
        collect([
          { id: two, amount: 10 },
          { id: two, amount: 10 },
        ]),
      )
    ).status,
  ).toBe(422);
});
it('records one receipt for academic and transport fees and never charges transport to non-users', async () => {
  const route = await call('post', '/fees/routes').send({
    name: 'Route A',
    description: 'North service',
  });
  expect(route.status, route.text).toBe(201);
  routeId = route.body.id;
  const input = {
    student_id: f.student,
    academic_session_id: f.session,
    route_id: routeId,
    amount: 25,
    frequency: 'ONE_TIME',
    starts_on: '2026-01-01',
    ends_on: '2026-12-31',
    first_due_on: '2026-01-01',
  };
  const transport = await call('post', '/fees/transport')
    .set('Idempotency-Key', 'transport-assignment-001')
    .send(input);
  expect(transport.status, transport.text).toBe(201);
  expect(
    (
      await call('post', '/fees/transport')
        .set('Idempotency-Key', 'transport-assignment-001')
        .send(input)
    ).body.id,
  ).toBe(transport.body.id);
  expect(
    (await call('post', '/fees/transport').set('Idempotency-Key', crypto.randomUUID()).send(input))
      .status,
  ).toBe(409);
  const transportFee = (
      await db.query<{ id: string }>(
        'SELECT id FROM fee_records WHERE transport_assignment_id=$1',
        [transport.body.id],
      )
    ).rows[0].id,
    academic = await assessment();
  const p = await pay(
    collect(
      [
        { id: academic, amount: 20 },
        { id: transportFee, amount: 25 },
      ],
      { payment_method: 'UPI', reference: 'UTR-123' },
    ),
  );
  expect(p.status, p.text).toBe(201);
  expect(p.body.receipt.lines).toHaveLength(2);
  expect(p.body.receipt.amount).toBe('45.00');
  expect(
    (
      await db.query("SELECT id FROM fee_records WHERE student_id=$1 AND category='TRANSPORT'", [
        secondStudent,
      ])
    ).rows,
  ).toEqual([]);
  const statement = await call(
    'get',
    `/fees/students/${f.student}?academic_session_id=${f.session}`,
    'parent',
  );
  expect(statement.status).toBe(200);
  expect(statement.body.summary[0]).toMatchObject({
    transport_expected: '25.00',
    transport_paid: '25.00',
    transport_outstanding: '0.00',
  });
  const receipt = await call('get', '/fees/payments/' + p.body.id, 'parent');
  expect(receipt.status).toBe(200);
  expect(receipt.body.receipt_snapshot).toEqual(p.body.receipt);
});
it('reverses payments with audit entries and retains original receipts and assessment values', async () => {
  const id = await assessment(),
    payment = await pay(collect([{ id, amount: 100 }]));
  expect(payment.status).toBe(201);
  expect(
    (await call('patch', '/resources/fee_records/' + id).send({ amount_due: 200 })).status,
  ).toBe(409);
  const reverse = await call('post', `/fees/payments/${payment.body.id}/reverse`)
    .set('Idempotency-Key', 'fee-reversal-001')
    .send({ reason: 'Wrong payment reference supplied' });
  expect(reverse.status, reverse.text).toBe(200);
  expect(
    (
      await call('post', `/fees/payments/${payment.body.id}/reverse`)
        .set('Idempotency-Key', 'fee-reversal-001')
        .send({ reason: 'Wrong payment reference supplied' })
    ).body.id,
  ).toBe(reverse.body.id);
  expect(
    (
      await call('post', `/fees/payments/${payment.body.id}/reverse`)
        .set('Idempotency-Key', 'fee-reversal-002')
        .send({ reason: 'Wrong payment reference supplied' })
    ).status,
  ).toBe(409);
  expect(
    (
      await db.query<{ amount_paid: string; status: string }>(
        'SELECT amount_paid,status FROM fee_records WHERE id=$1',
        [id],
      )
    ).rows[0],
  ).toEqual({ amount_paid: '0.00', status: 'UNPAID' });
  const original = await call('get', '/fees/payments/' + payment.body.id, 'parent');
  expect(original.body.receipt_snapshot).toEqual(payment.body.receipt);
  expect(original.body.reversal_reason).toBeTruthy();
  const corrected = await pay(
    collect([{ id, amount: 100 }], { receipt_no: 'CORRECTED-RECEIPT-001' }),
  );
  expect(corrected.status).toBe(201);
  expect(
    (
      await db.query(
        "SELECT id FROM audit_logs WHERE school_id=$1 AND entity_type='fee_payment_reversals'",
        [f.schoolA],
      )
    ).rows.length,
  ).toBeGreaterThan(0);
});
it('limits finance staff to financial workflows and prevents parent/student/teacher/principal writes', async () => {
  const id = await assessment();
  for (const role of ['parent', 'student', 'teacher', 'principal'])
    expect((await pay(collect([{ id, amount: 10 }]), crypto.randomUUID(), role)).status).toBe(403);
  const financePayment = await pay(collect([{ id, amount: 20 }]), crypto.randomUUID(), 'finance');
  expect(financePayment.status, financePayment.text).toBe(201);
  expect(
    (
      await pay(
        collect([{ id, amount: 10 }], { receipt_no: 'FORGED' }),
        crypto.randomUUID(),
        'finance',
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await call(
        'get',
        `/fees/students/${secondStudent}?academic_session_id=${f.session}`,
        'finance',
      )
    ).status,
  ).toBe(200);
  expect((await call('get', '/resources/students', 'finance')).status).toBe(403);
  expect(
    (await call('post', '/resources/subjects', 'finance').send({ code: 'NO', name: 'Forbidden' }))
      .status,
  ).toBe(403);
  expect((await call('get', '/fees/reports', 'parent')).status).toBe(403);
  expect((await call('get', '/fees/reports', 'principal')).status).toBe(200);
});
it('enforces school and family isolation in API and direct database queries', async () => {
  const second = await assessment(100, secondStudent),
    payment = await pay(collect([{ id: second, amount: 10 }], { student_id: secondStudent }));
  expect(payment.status).toBe(201);
  for (const role of ['parent', 'student']) {
    expect(
      (await call('get', `/fees/students/${secondStudent}?academic_session_id=${f.session}`, role))
        .status,
    ).toBe(404);
    expect((await call('get', '/fees/payments/' + payment.body.id, role)).status).toBe(404);
    const rows = await transaction(
      poolAdapters(db).api,
      { schoolId: f.schoolA, userId: role === 'parent' ? f.parent : f.studentUser },
      async (tx) => ({
        fees: (await tx.query('SELECT id FROM fee_records WHERE student_id=$1', [secondStudent]))
          .rows,
        payments: (
          await tx.query('SELECT id FROM fee_payments WHERE student_id=$1', [secondStudent])
        ).rows,
      }),
    );
    expect(rows).toEqual({ fees: [], payments: [] });
  }
  expect(
    (await call('get', `/fees/students/${f.foreignStudent}?academic_session_id=${f.session}`))
      .status,
  ).toBe(404);
  await db.query(
    "UPDATE student_parents SET status='REVOKED' WHERE school_id=$1 AND parent_id=$2",
    [f.schoolA, f.parentId],
  );
  expect(
    (await call('get', `/fees/students/${f.student}?academic_session_id=${f.session}`, 'parent'))
      .status,
  ).toBe(404);
  await db.query("UPDATE student_parents SET status='ACTIVE' WHERE school_id=$1 AND parent_id=$2", [
    f.schoolA,
    f.parentId,
  ]);
});
it('database rejects manual paid totals, mutable payments, unbalanced receipts and cross-student allocations', async () => {
  const id = await assessment(),
    p = await pay(collect([{ id, amount: 1 }])),
    ctx = { schoolId: f.schoolA, userId: f.admin },
    pool = poolAdapters(db).api;
  await expect(
    transaction(pool, ctx, (tx) =>
      tx.query('UPDATE fee_records SET amount_paid=99 WHERE school_id=$1 AND id=$2', [
        f.schoolA,
        id,
      ]),
    ),
  ).rejects.toMatchObject({ code: '23514' });
  await expect(
    transaction(pool, ctx, (tx) =>
      tx.query("UPDATE fee_payments SET note='tampered' WHERE id=$1", [p.body.id]),
    ),
  ).rejects.toMatchObject({ code: '42501' });
  await expect(
    transaction(pool, ctx, async (tx) => {
      await tx.query(
        "INSERT INTO fee_payments(school_id,student_id,academic_session_id,payment_date,amount,currency,payment_method,recorded_by,receipt_snapshot,idempotency_key,request_hash) VALUES($1,$2,$3,'2026-01-01',20,'INR','CASH',$4,'{}',$5,'hash')",
        [f.schoolA, f.student, f.session, f.admin, crypto.randomUUID()],
      );
    }),
  ).rejects.toMatchObject({ code: '23514' });
  const other = await assessment(20, secondStudent);
  await expect(
    transaction(pool, ctx, (tx) =>
      tx.query(
        'INSERT INTO fee_payment_allocations(school_id,payment_id,fee_id,amount) VALUES($1,$2,$3,1)',
        [f.schoolA, p.body.id, other],
      ),
    ),
  ).rejects.toMatchObject({ code: '23514' });
});
it('reports exact date/category collections, protects CSV formulas and exports historical reversals', async () => {
  const id = await assessment();
  await db.query("UPDATE students SET first_name='=SUM(1,2)' WHERE id=$1", [f.student]);
  const payment = await pay(
    collect([{ id, amount: 12.34 }], { payment_date: '2026-02-01', reference: '@formula' }),
  );
  expect(payment.status).toBe(201);
  const report = await call(
    'get',
    `/fees/reports?academic_session_id=${f.session}&student_id=${f.student}&from=2026-02-01&to=2026-02-01`,
  );
  expect(report.status, report.text).toBe(200);
  expect(
    report.body.collections.reduce(
      (s: number, r: { collected: string }) => s + Number(r.collected),
      0,
    ),
  ).toBe(12.34);
  const csv = await call(
    'get',
    `/fees/reports/export?academic_session_id=${f.session}&search=${encodeURIComponent(payment.body.receipt.receipt_no)}`,
  );
  expect(csv.status).toBe(200);
  expect(csv.body.csv).toContain("'=SUM(1,2)");
  expect(csv.body.csv).toContain("'@formula");
  await db.query("UPDATE students SET first_name='Test learner' WHERE id=$1", [f.student]);
});
it('voids future unpaid transport when service ends and blocks writes for read-only subscriptions', async () => {
  const input = {
    student_id: secondStudent,
    academic_session_id: f.session,
    route_id: routeId,
    amount: 10,
    frequency: 'MONTHLY',
    starts_on: '2026-01-01',
    ends_on: '2026-04-30',
    first_due_on: '2026-01-01',
  };
  const ta = await call('post', '/fees/transport')
    .set('Idempotency-Key', crypto.randomUUID())
    .send(input);
  expect(ta.status, ta.text).toBe(201);
  const end = await call('post', `/fees/transport/${ta.body.id}/end`).send({
    ended_on: '2026-02-15',
    reason: 'Student stopped using bus service',
  });
  expect(end.status, end.text).toBe(200);
  const rows = (
    await db.query<{ status: string; voided_at: string }>(
      "SELECT status,voided_at FROM fee_records WHERE transport_assignment_id=$1 AND due_on>'2026-02-15'",
      [ta.body.id],
    )
  ).rows;
  expect(rows).toHaveLength(2);
  expect(rows.every((r) => r.status === 'WAIVED' && r.voided_at)).toBe(true);
  const restarted = await call('post', '/fees/transport')
    .set('Idempotency-Key', crypto.randomUUID())
    .send({
      ...input,
      amount: 15,
      frequency: 'ONE_TIME',
      starts_on: '2026-03-01',
      first_due_on: '2026-03-01',
    });
  expect(restarted.status, restarted.text).toBe(201);
  const march = (
    await db.query<{ amount_due: string; status: string }>(
      "SELECT amount_due,status FROM fee_records WHERE student_id=$1 AND category='TRANSPORT' AND due_on='2026-03-01' ORDER BY amount_due",
      [secondStudent],
    )
  ).rows;
  expect(march).toEqual([
    { amount_due: '10.00', status: 'WAIVED' },
    { amount_due: '15.00', status: 'UNPAID' },
  ]);
  await db.query("UPDATE subscriptions SET status='SUSPENDED' WHERE school_id=$1", [f.schoolA]);
  expect((await call('post', '/fees/routes').send({ name: 'Blocked route' })).status).toBe(403);
  await db.query("UPDATE subscriptions SET status='ACTIVE' WHERE school_id=$1", [f.schoolA]);
});
