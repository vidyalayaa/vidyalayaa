import { beforeAll, afterAll, it, expect } from 'vitest';
import request from 'supertest';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fixture, portableDatabase, poolAdapters } from '../helpers/database.js';
import { fixtureBearer, withProviderSessions } from '../helpers/provider-sessions.js';

import { createApp } from '../../apps/api/src/app.js';
import { transaction } from '../../apps/api/src/lib/db.js';
import type { Config } from '../../apps/api/src/lib/config.js';
let db: PGlite,
  f: Awaited<ReturnType<typeof fixture>>,
  pools: ReturnType<typeof poolAdapters>,
  app: ReturnType<typeof createApp>;
const call = (path: string, role = 'student') =>
  request(app)
    .get('/api/v1' + path)
    .set('Authorization', 'Bearer ' + fixtureBearer(role))
    .set('X-School-Id', f.schoolA);
beforeAll(async () => {
  db = await portableDatabase();
  f = await fixture(db);
  pools = poolAdapters(db);
  const identities: Record<string, string> = {
    student: f.studentUser,
    admin: f.admin,
    parent: f.parent,
    teacher: f.teacher,
    principal: f.principal,
  };
  const auth = {
    auth: {
      getUser: async (token: string) => ({
        data: { user: identities[token] ? { id: identities[token] } : null },
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
    { ...pools, supabase: withProviderSessions(db, auth) },
  );
});
afterAll(async () => db?.close());
const mutate = (method: 'post' | 'patch', path: string, role = 'admin') =>
  request(app)
    [method]('/api/v1' + path)
    .set('Authorization', 'Bearer ' + fixtureBearer(role))
    .set('X-School-Id', f.schoolA);
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const shift = (date: string, days: number) =>
  new Date(Date.parse(date + 'T12:00:00Z') + days * 86400000).toISOString().slice(0, 10);
let run: any,
  workspace: any,
  plan: any,
  preview: any,
  extraClass: string,
  admittedStudent = crypto.randomUUID(),
  repeatStudent = crypto.randomUUID(),
  graduateStudent = crypto.randomUUID();
it('requires School Admin and an authorized school even for previews and history', async () => {
  for (const role of ['teacher', 'principal', 'student', 'parent']) {
    expect((await call('/promotion/workspace', role)).status).toBe(403);
    expect((await mutate('post', '/promotion/prepare', role).send({})).status).toBe(403);
    expect((await mutate('post', '/promotion/activate', role).send({})).status).toBe(403);
  }
  expect((await request(app).get('/api/v1/promotion/workspace')).status).toBe(401);
  expect((await call('/promotion/workspace', 'admin').set('X-School-Id', f.schoolB)).status).toBe(
    404,
  );
});
it('prepares new-year classes, subject teachers, timetable and fee templates without promoting anyone', async () => {
  await db.query('UPDATE academic_sessions SET ends_on=$2 WHERE id=$1', [
    f.session,
    shift(today, -1),
  ]);
  extraClass = crypto.randomUUID();
  await db.query(
    "INSERT INTO classes(id,school_id,academic_session_id,grade,section,class_teacher_id) VALUES($1,$2,$3,'9','A',$4)",
    [extraClass, f.schoolA, f.session, f.teacherId],
  );
  await db.query(
    "INSERT INTO teacher_class_assignments(school_id,class_id,subject_id,teacher_id,starts_on) VALUES($1,$2,$3,$4,'2026-01-01')",
    [f.schoolA, extraClass, f.subject, f.teacherId],
  );
  await db.query(
    "INSERT INTO timetable_entries(school_id,class_id,subject_id,teacher_id,weekday,starts_at,ends_at) VALUES($1,$2,$3,$4,1,'09:00','09:40')",
    [f.schoolA, extraClass, f.subject, f.teacherId],
  );
  for (const [student, code] of [
    [repeatStudent, 'REPEAT'],
    [graduateStudent, 'GRAD'],
  ]) {
    await db.query(
      'INSERT INTO students(id,school_id,student_code,first_name) VALUES($1,$2,$3,$3)',
      [student, f.schoolA, code],
    );
    await db.query(
      "INSERT INTO enrollments(school_id,student_id,class_id,academic_session_id,starts_on,roll_number) VALUES($1,$2,$3,$4,'2026-01-01',$5)",
      [f.schoolA, student, f.classId, f.session, code],
    );
  }
  await db.query(
    "INSERT INTO student_parents(school_id,student_id,parent_id,relationship) VALUES($1,$2,$3,'GUARDIAN')",
    [f.schoolA, repeatStudent, f.parentId],
  );
  await db.query(
    "INSERT INTO fee_records(school_id,student_id,academic_session_id,class_id,fee_type,amount_due,due_on,status) VALUES($1,$2,$3,$4,'Existing balance',90,$5,'UNPAID')",
    [f.schoolA, f.student, f.session, f.classId, shift(today, -2)],
  );
  for (const [grade, class_id, amount] of [
    ['8', f.classId, 100],
    ['9', extraClass, 1000],
  ] as const) {
    const result = await mutate('post', '/fees/structures')
      .set('Idempotency-Key', crypto.randomUUID())
      .send({
        academic_session_id: f.session,
        grade,
        mode: 'SAME',
        expected_version: 0,
        items: [
          {
            class_id: null,
            category: 'TUITION',
            label: 'Tuition',
            amount,
            frequency: 'ANNUAL',
            // The following month stays inside the target year even when it starts mid-month.
            first_due_on: '2026-02-01',
          },
        ],
      });
    expect(result.status, JSON.stringify(result.body)).toBe(201);
  }
  const body = {
    source_session_id: f.session,
    new_year: { name: 'Promotion target', starts_on: today, ends_on: shift(today, 364) },
    copy_teaching: true,
    copy_timetable: true,
    copy_fees: true,
  };
  const key = crypto.randomUUID();
  const response = await mutate('post', '/promotion/prepare')
    .set('Idempotency-Key', key)
    .send(body);
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  run = response.body;
  expect(
    (await mutate('post', '/promotion/prepare').set('Idempotency-Key', key).send(body)).body.id,
  ).toBe(run.id);
  expect(run.class_copies).toHaveLength(2);
  expect(
    (await db.query('SELECT is_current FROM academic_sessions WHERE id=$1', [f.session])).rows[0]
      .is_current,
  ).toBe(true);
  expect(
    (
      await db.query('SELECT id FROM enrollments WHERE academic_session_id=$1', [
        run.target_session_id,
      ])
    ).rows,
  ).toHaveLength(0);
  const schedules = await db.query(
    'SELECT academic_session_id FROM timetable_entries WHERE teacher_id=$1',
    [f.teacherId],
  );
  expect(schedules.rows).toHaveLength(2);
  workspace = (await call('/promotion/workspace', 'admin')).body;
  const target8 = workspace.classes.find(
      (c: any) => c.academic_session_id === run.target_session_id && c.grade === '8',
    ),
    target9 = workspace.classes.find(
      (c: any) => c.academic_session_id === run.target_session_id && c.grade === '9',
    );
  const records = (await call(`/promotion/${run.id}/students`, 'admin')).body.data;
  plan = {
    promotion_id: run.id,
    activation_on: today,
    generate_fees: true,
    roll_numbers: 'KEEP',
    mappings: [
      {
        source_class_id: f.classId,
        target_class_id: target9.id,
        fee_structure_id: workspace.structures.find(
          (s: any) => s.academic_session_id === run.target_session_id && s.grade === '9',
        ).id,
        outcome: 'PROMOTE',
      },
      {
        source_class_id: extraClass,
        target_class_id: null,
        fee_structure_id: null,
        outcome: 'GRADUATED',
      },
    ],
    exceptions: [
      {
        enrollment_id: records.find((e: any) => e.student_id === repeatStudent).id,
        outcome: 'REPEAT',
        target_class_id: target8.id,
        roll_number: '2',
        reason: 'Repeat this grade by school decision',
      },
      {
        enrollment_id: records.find((e: any) => e.student_id === graduateStudent).id,
        outcome: 'GRADUATED',
        target_class_id: null,
        roll_number: null,
        reason: 'Completed final year',
      },
    ],
  };
});
it('previews exact new fees and retained balances without changing enrollments or billing', async () => {
  const response = await mutate('post', '/promotion/preview').send(plan);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  preview = response.body;
  expect(preview.blockers).toEqual([]);
  expect(preview.counts).toMatchObject({ promoted: 1, repeating: 1, graduated: 1, total: 3 });
  expect(preview.fees).toMatchObject({ installments: 2, amount: '1100.00' });
  expect(preview.old_balances).toEqual([{ currency: 'INR', balance: '90.00' }]);
  expect(
    (
      await db.query('SELECT id FROM fee_records WHERE academic_session_id=$1', [
        run.target_session_id,
      ])
    ).rows,
  ).toEqual([]);
  expect(
    (
      await db.query('SELECT id FROM enrollments WHERE academic_session_id=$1', [
        run.target_session_id,
      ])
    ).rows,
  ).toEqual([]);
});
it('isolates the promotion ledger through database policies and rejects cross-school locks', async () => {
  for (const userId of [f.teacher, f.principal, f.studentUser, f.parent]) {
    const result = await transaction(pools.api, { schoolId: f.schoolA, userId }, (tx) =>
      tx.query('SELECT id FROM academic_promotions'),
    );
    expect(result.rows).toEqual([]);
  }
  const otherSchool = await transaction(pools.api, { schoolId: f.schoolB, userId: f.admin }, (tx) =>
    tx.query('SELECT id FROM academic_promotions'),
  );
  expect(otherSchool.rows).toEqual([]);
  await expect(
    transaction(pools.api, { schoolId: f.schoolA, userId: f.admin }, (tx) =>
      tx.query('SELECT app.lock_academic_year($1,$2)', [f.schoolB, f.session]),
    ),
  ).rejects.toMatchObject({ code: '42501' });
});
it('rejects tampered confirmations, changed records, future dates and invalid destination years', async () => {
  const forged = await mutate('post', '/promotion/activate').send({
    plan,
    token: preview.token.slice(0, -5) + 'fffff',
    confirmation: 'ACTIVATE',
  });
  expect(forged.status).toBe(409);
  await db.query(
    'UPDATE enrollments SET roll_number=$2 WHERE student_id=$1 AND academic_session_id=$3',
    [f.student, 'UPDATED', f.session],
  );
  const stale = await mutate('post', '/promotion/activate').send({
    plan,
    token: preview.token,
    confirmation: 'ACTIVATE',
  });
  expect(stale.status, JSON.stringify(stale.body)).toBe(409);
  const future = await mutate('post', '/promotion/preview').send({
    ...plan,
    activation_on: shift(today, 1),
  });
  expect(future.body.blockers.join(' ')).toContain('future date');
  const wrong = await mutate('post', '/promotion/preview').send({
    ...plan,
    mappings: plan.mappings.map((m: any) => ({ ...m, target_class_id: f.classId })),
  });
  expect(wrong.body.blockers.length).toBeGreaterThan(0);
  preview = (await mutate('post', '/promotion/preview').send(plan)).body;
  expect(preview.blockers).toEqual([]);
});
it('previews only the promotion roster while preserving separately admitted new-year students', async () => {
  const destination = plan.mappings[0].target_class_id;
  await db.query(
    "INSERT INTO students(id,school_id,student_code,first_name) VALUES($1,$2,'NEW','New admission')",
    [admittedStudent, f.schoolA],
  );
  await db.query(
    'INSERT INTO enrollments(school_id,student_id,class_id,academic_session_id,starts_on,roll_number) VALUES($1,$2,$3,$4,$5,$6)',
    [f.schoolA, admittedStudent, destination, run.target_session_id, today, 'NEW'],
  );
  preview = (await mutate('post', '/promotion/preview').send(plan)).body;
  expect(preview.blockers).toEqual([]);
  expect(preview.fees).toMatchObject({ installments: 2, amount: '1100.00' });
  expect(preview.counts.total).toBe(3);
});
it('rolls back enrollment and year changes when fee generation fails', async () => {
  await db.exec(`CREATE FUNCTION app.test_promotion_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Test fee failure' USING ERRCODE='23514';END $$;
    CREATE TRIGGER test_promotion_failure BEFORE INSERT ON fee_records FOR EACH ROW EXECUTE FUNCTION app.test_promotion_failure();`);
  try {
    const response = await mutate('post', '/promotion/activate').send({
      plan,
      token: preview.token,
      confirmation: 'ACTIVATE',
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(
      (
        await db.query('SELECT is_current,closed_at FROM academic_sessions WHERE id=$1', [
          f.session,
        ])
      ).rows[0],
    ).toMatchObject({ is_current: true, closed_at: null });
    expect(
      (
        await db.query(
          "SELECT id FROM enrollments WHERE academic_session_id=$1 AND status='ACTIVE'",
          [f.session],
        )
      ).rows,
    ).toHaveLength(3);
    expect(
      (
        await db.query('SELECT id FROM enrollments WHERE academic_session_id=$1', [
          run.target_session_id,
        ])
      ).rows,
    ).toHaveLength(1);
    expect(
      (await db.query('SELECT status FROM academic_promotions WHERE id=$1', [run.id])).rows[0]
        .status,
    ).toBe('PREPARED');
  } finally {
    await db.exec(
      'DROP TRIGGER test_promotion_failure ON fee_records;DROP FUNCTION app.test_promotion_failure();',
    );
  }
});
it('atomically promotes, repeats and graduates while keeping accounts, family links, old balances and schedules', async () => {
  const before = (
    await db.query('SELECT id,user_id,student_code FROM students WHERE id=$1', [f.student])
  ).rows[0];
  const response = await mutate('post', '/promotion/activate').send({
    plan,
    token: preview.token,
    confirmation: 'ACTIVATE',
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body.fees_created).toBe(2);
  expect(
    (await db.query('SELECT id,user_id,student_code FROM students WHERE id=$1', [f.student]))
      .rows[0],
  ).toEqual(before);
  const links = await db.query(
    'SELECT student_id,parent_id FROM student_parents WHERE parent_id=$1',
    [f.parentId],
  );
  expect(links.rows).toHaveLength(2);
  const years = (
    await db.query(
      'SELECT id,is_current,closed_at FROM academic_sessions WHERE school_id=$1 ORDER BY starts_on',
      [f.schoolA],
    )
  ).rows;
  expect(years.find((y: any) => y.id === f.session)).toMatchObject({ is_current: false });
  expect(years.find((y: any) => y.id === f.session).closed_at).toBeTruthy();
  expect(years.find((y: any) => y.id === run.target_session_id).is_current).toBe(true);
  const current = (
    await db.query(
      "SELECT e.student_id,c.grade FROM enrollments e JOIN classes c ON c.id=e.class_id WHERE e.academic_session_id=$1 AND e.status='ACTIVE'",
      [run.target_session_id],
    )
  ).rows;
  expect(current).toContainEqual({ student_id: f.student, grade: '9' });
  expect(current).toContainEqual({ student_id: repeatStudent, grade: '8' });
  expect(current).toContainEqual({ student_id: admittedStudent, grade: '9' });
  expect(current).toHaveLength(3);
  expect(
    (await db.query('SELECT status FROM students WHERE id=$1', [graduateStudent])).rows[0].status,
  ).toBe('ACTIVE');
  expect(
    (
      await db.query(
        'SELECT amount_due,amount_paid FROM fee_records WHERE academic_session_id=$1',
        [f.session],
      )
    ).rows,
  ).toEqual([{ amount_due: '90.00', amount_paid: '0.00' }]);
  const again = await mutate('post', '/promotion/activate').send({
    plan,
    token: preview.token,
    confirmation: 'ACTIVATE',
  });
  expect(again.status).toBe(200);
  expect(again.body).toEqual(response.body);
  expect(
    (
      await db.query('SELECT id FROM fee_records WHERE academic_session_id=$1', [
        run.target_session_id,
      ])
    ).rows,
  ).toHaveLength(2);
});
it('makes old-year history read-only at the database and keeps fee collection available', async () => {
  expect(
    (await db.query('SELECT id FROM fee_records WHERE student_id=$1', [admittedStudent])).rows,
  ).toEqual([]);
  await expect(
    transaction(pools.api, { schoolId: f.schoolA, userId: f.admin }, (tx) =>
      tx.query("UPDATE academic_promotions SET status='PREPARED' WHERE id=$1", [run.id]),
    ),
  ).rejects.toMatchObject({ code: '23514' });
  for (const path of [
    'students',
    'attendance',
    'results',
    'homework',
    'subjects',
    'timetable',
    'fees',
    'payments',
  ]) {
    const response = await call(`/promotion/history/${f.session}?section=${path}`, 'admin');
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.session.closed_at).toBeTruthy();
  }
  const historical = await call(`/promotion/history/${f.session}?section=students`, 'admin');
  expect(historical.body.data.find((s: any) => s.student_code === 'STU001')).toMatchObject({
    grade: '8',
    status: 'ENDED',
  });
  await expect(
    transaction(pools.api, { schoolId: f.schoolA, userId: f.admin }, (tx) =>
      tx.query('UPDATE classes SET grade=$2 WHERE id=$1', [f.classId, 'ALTERED']),
    ),
  ).rejects.toMatchObject({ code: '23514' });
  await expect(
    transaction(pools.api, { schoolId: f.schoolA, userId: f.teacher }, (tx) =>
      tx.query('UPDATE enrollments SET roll_number=$2 WHERE student_id=$1', [f.student, 'HACK']),
    ),
  ).rejects.toBeTruthy();
  const oldFee = (
    await db.query('SELECT id FROM fee_records WHERE academic_session_id=$1', [f.session])
  ).rows[0];
  const collected = await mutate('post', '/fees/payments')
    .set('Idempotency-Key', crypto.randomUUID())
    .send({
      student_id: f.student,
      academic_session_id: f.session,
      payment_date: today,
      payment_method: 'CASH',
      reference: '',
      note: 'Old balance collection',
      allocations: [{ fee_id: oldFee.id, amount: 90 }],
    });
  expect(collected.status, JSON.stringify(collected.body)).toBe(201);
});
