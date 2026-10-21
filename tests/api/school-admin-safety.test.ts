import { beforeAll, afterAll, it, expect } from 'vitest';
import request from 'supertest';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { portableDatabase, poolAdapters, fixture } from '../helpers/database.js';
import { createApp } from '../../apps/api/src/app.js';
import type { Config } from '../../apps/api/src/lib/config.js';

let db: PGlite, f: Awaited<ReturnType<typeof fixture>>, app: ReturnType<typeof createApp>;
beforeAll(async () => {
  db = await portableDatabase();
  f = await fixture(db);
  const auth = {
    auth: {
      getUser: async (token: string) => ({
        data: { user: { id: f[token as 'admin'] } },
        error: null,
      }),
    },
  } as unknown as SupabaseClient;
  app = createApp(
    {
      NODE_ENV: 'test',
      WEB_ORIGINS: 'http://localhost:5173',
      TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32),
      TRUST_PROXY_HOPS: 0,
    } as Config,
    { ...poolAdapters(db), supabase: auth },
  );
});
afterAll(async () => db.close());
const call = (method: 'get' | 'post', path: string, role = 'admin') =>
  request(app)
    [method]('/api/v1' + path)
    .set('Authorization', 'Bearer ' + role)
    .set('X-School-Id', f.schoolA);
async function fee(type: string, status = 'UNPAID') {
  return (
    await db.query<{ id: string }>(
      "INSERT INTO fee_records(school_id,student_id,academic_session_id,fee_type,amount_due,status,due_on) VALUES($1,$2,$3,$4,100,$5,'2026-10-21') RETURNING id",
      [f.schoolA, f.student, f.session, type, status],
    )
  ).rows[0].id;
}

it('replays a payment once with the same durable receipt and rejects key reuse with changed contents', async () => {
  const id = await fee('Retry-safe payment');
  const body = { amount: 40, payment_method: 'CASH', note: 'Verified cash reference' };
  const first = await call('post', `/fees/${id}/pay`)
    .set('Idempotency-Key', 'payment-retry-001')
    .send(body);
  const retry = await call('post', `/fees/${id}/pay`)
    .set('Idempotency-Key', 'payment-retry-001')
    .send(body);
  expect(first.status).toBe(200);
  expect(retry.status).toBe(200);
  expect(retry.body.receipt).toEqual(first.body.receipt);
  expect(Number(retry.body.amount_paid)).toBe(40);
  expect(
    (
      await call('post', `/fees/${id}/pay`)
        .set('Idempotency-Key', 'payment-retry-001')
        .send({ ...body, amount: 20 })
    ).status,
  ).toBe(409);
  expect(
    Number(
      (
        await db.query<{ amount_paid: string }>('SELECT amount_paid FROM fee_records WHERE id=$1', [
          id,
        ])
      ).rows[0].amount_paid,
    ),
  ).toBe(40);
});

it('rejects overpayments, waived fees, sub-cent amounts and missing payment retry keys without changing the balance', async () => {
  const id = await fee('Overpayment guard'),
    waived = await fee('Waived payment guard', 'WAIVED');
  for (const [target, body, key, status] of [
    [id, { amount: 101 }, 'overpay-attempt-001', 409],
    [waived, { amount: 1 }, 'waived-attempt-001', 409],
    [id, { amount: 0.001 }, 'fraction-attempt-001', 422],
    [id, { amount: 1 }, '', 422],
  ] as const) {
    let req = call('post', `/fees/${target}/pay`);
    if (key) req = req.set('Idempotency-Key', key);
    expect((await req.send(body)).status).toBe(status);
  }
  expect(
    Number(
      (
        await db.query<{ amount_paid: string }>('SELECT amount_paid FROM fee_records WHERE id=$1', [
          id,
        ])
      ).rows[0].amount_paid,
    ),
  ).toBe(0);
});

it('bulk attendance preserves NFC evidence and rolls back the entire batch', async () => {
  const first = '00000000-0000-4000-8000-000000000111';
  await db.query(
    "INSERT INTO students(id,school_id,student_code,first_name) VALUES($1,$2,'ATOMIC_WEB','Atomic learner')",
    [first, f.schoolA],
  );
  await db.query(
    "INSERT INTO enrollments(school_id,student_id,class_id,academic_session_id,starts_on) VALUES($1,$2,$3,$4,'2026-01-01')",
    [f.schoolA, first, f.classId, f.session],
  );
  await db.query(
    "INSERT INTO daily_attendance(school_id,student_id,class_id,academic_session_id,attendance_date,attendance_status,source,version) VALUES($1,$2,$3,$4,'2026-10-11','PRESENT','NFC',1)",
    [f.schoolA, f.student, f.classId, f.session],
  );
  const r = await call('post', '/attendance/bulk')
    .set('Idempotency-Key', 'nfc-batch-001')
    .send({
      class_id: f.classId,
      date: '2026-10-11',
      reason: 'Generated NFC protection check',
      records: [
        { student_id: first, status: 'PRESENT', expected_version: 0 },
        { student_id: f.student, status: 'ABSENT', expected_version: 1 },
      ],
    });
  expect(r.status).toBe(409);
  expect(r.body.error.code).toBe('CORRECTION_REQUIRED');
  expect(
    (
      await db.query(
        'SELECT attendance_status,source,version FROM daily_attendance WHERE student_id=$1 AND attendance_date=$2',
        [f.student, '2026-10-11'],
      )
    ).rows[0],
  ).toMatchObject({ attendance_status: 'PRESENT', source: 'NFC', version: 1 });
  expect(
    (await db.query('SELECT id FROM daily_attendance WHERE student_id=$1', [first])).rows,
  ).toHaveLength(0);
  expect(
    (await db.query('SELECT id FROM notification_outbox WHERE student_id=$1', [first])).rows,
  ).toHaveLength(0);
});

it('bulk attendance rejects unenrolled students, duplicates, empty batches and stale versions', async () => {
  const unenrolled = (
    await db.query<{ id: string }>(
      "INSERT INTO students(school_id,student_code,first_name) VALUES($1,'NO_CLASS','No class learner') RETURNING id",
      [f.schoolA],
    )
  ).rows[0].id;
  const base = { class_id: f.classId, date: '2026-10-12', reason: 'Generated register validation' };
  expect(
    (
      await call('post', '/attendance/bulk').send({
        ...base,
        records: [{ student_id: unenrolled, status: 'PRESENT' }],
      })
    ).status,
  ).toBe(422);
  expect((await call('post', '/attendance/bulk').send({ ...base, records: [] })).status).toBe(422);
  expect(
    (
      await call('post', '/attendance/bulk').send({
        ...base,
        records: [
          { student_id: f.student, status: 'PRESENT' },
          { student_id: f.student, status: 'ABSENT' },
        ],
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await call('post', '/attendance/bulk').send({
        ...base,
        records: [{ student_id: f.student, status: 'PRESENT', expected_version: 5 }],
      })
    ).status,
  ).toBe(409);
});

it('bulk attendance retries once, notifies once and preserves its class academic session', async () => {
  const body = {
    class_id: f.classId,
    date: '2026-10-13',
    reason: 'Generated classroom register',
    records: [{ student_id: f.student, status: 'EXCUSED', expected_version: 0 }],
  };
  const first = await call('post', '/attendance/bulk')
    .set('Idempotency-Key', 'class-register-retry-001')
    .send(body);
  expect(first.status).toBe(200);
  expect(
    (
      await call('post', '/attendance/bulk')
        .set('Idempotency-Key', 'class-register-retry-001')
        .send(body)
    ).body,
  ).toEqual(first.body);
  const day = (
    await db.query(
      'SELECT id,version,academic_session_id FROM daily_attendance WHERE student_id=$1 AND attendance_date=$2',
      [f.student, body.date],
    )
  ).rows[0];
  expect(day).toMatchObject({ version: 1, academic_session_id: f.session });
  expect(
    (
      await db.query(
        'SELECT count(*)::int AS n FROM notification_outbox WHERE dedupe_key LIKE $1',
        ['ATTENDANCE_CORRECTED:' + day.id + ':%'],
      )
    ).rows[0].n,
  ).toBe(1);
});

it('card issue retry returns the original card without retiring it again', async () => {
  const body = { student_id: f.student, card_uid: '01020304' };
  const first = await call('post', '/cards/issue')
    .set('Idempotency-Key', 'card-issue-retry-001')
    .send(body);
  expect(first.status).toBe(201);
  const retry = await call('post', '/cards/issue')
    .set('Idempotency-Key', 'card-issue-retry-001')
    .send(body);
  expect(retry.status).toBe(201);
  expect(retry.body.id).toBe(first.body.id);
  expect(
    (await db.query('SELECT status FROM nfc_cards WHERE id=$1', [first.body.id])).rows[0].status,
  ).toBe('ACTIVE');
});

it('student overview never gives teachers fee records or marks outside their assigned subject', async () => {
  await fee('Private school administration fee');
  const subject = (
    await db.query<{ id: string }>(
      "INSERT INTO subjects(school_id,code,name) VALUES($1,'PRIVATE_SUB','Unassigned subject') RETURNING id",
      [f.schoolA],
    )
  ).rows[0].id;
  const exam = (
    await db.query<{ id: string }>(
      "INSERT INTO exams(school_id,class_id,name,exam_type,max_score,status,assessment_kind,subject_id) VALUES($1,$2,'Subject access assessment','UNIT',100,'OPEN','SUBJECT_TEST',$3) RETURNING id",
      [f.schoolA, f.classId, f.subject],
    )
  ).rows[0].id;
  await db.query(
    'INSERT INTO marks(school_id,exam_id,student_id,subject_id,score,entered_by) VALUES($1,$2,$3,$4,77,$5)',
    [f.schoolA, exam, f.student, subject, f.admin],
  );
  const teacher = await call('get', `/students/${f.student}/overview`, 'teacher');
  expect(teacher.status).toBe(200);
  expect(teacher.body.fees.records).toEqual([]);
  expect(Number(teacher.body.fees.summary.total_due)).toBe(0);
  expect(
    teacher.body.marks.some(
      (m: { subject_name: string }) => m.subject_name === 'Unassigned subject',
    ),
  ).toBe(false);
  const admin = await call('get', `/students/${f.student}/overview`);
  expect(admin.body.fees.records.length).toBeGreaterThan(0);
  expect(
    admin.body.marks.some((m: { subject_name: string }) => m.subject_name === 'Unassigned subject'),
  ).toBe(true);
  expect((await call('get', `/students/${f.foreignStudent}/overview`)).status).toBe(404);
});
