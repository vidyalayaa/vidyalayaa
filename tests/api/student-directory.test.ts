import { fixtureBearer, withProviderSessions } from '../helpers/provider-sessions.js';
import { beforeAll, afterAll, it, expect } from 'vitest';
import request from 'supertest';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { portableDatabase, poolAdapters, fixture } from '../helpers/database.js';
import { createApp } from '../../apps/api/src/app.js';
import type { Config } from '../../apps/api/src/lib/config.js';
let db: PGlite, f: Awaited<ReturnType<typeof fixture>>, app: ReturnType<typeof createApp>;
const root = crypto.randomUUID();
const call = (method: 'get' | 'post' | 'patch', path: string, role = 'admin') =>
  request(app)
    [method]('/api/v1' + path)
    .set('Authorization', 'Bearer ' + fixtureBearer(role))
    .set('X-School-Id', f.schoolA);
const payload = (code: string) => ({
  student: {
    student_code: code,
    first_name: 'Admission ' + code,
    last_name: 'Learner',
    email: code.toLowerCase() + '@example.test',
    date_of_birth: '2012-04-03',
  },
  enrollment: { class_id: f.classId, starts_on: '2026-01-01', roll_number: code },
  guardians: [
    {
      parent: {
        full_name: 'Guardian ' + code,
        email: code.toLowerCase() + '-parent@example.test',
        phone: '9876543210',
      },
      relationship: 'MOTHER',
      is_primary_contact: true,
      can_receive_alerts: true,
    },
  ],
});
const admit = (body: unknown, key = crypto.randomUUID()) =>
  call('post', '/student-directory/admissions').set('Idempotency-Key', key).send(body);
beforeAll(async () => {
  db = await portableDatabase();
  f = await fixture(db);
  await db.query("INSERT INTO auth.users(id,email) VALUES($1,'directory-root@example.invalid')", [
    root,
  ]);
  await db.query("INSERT INTO platform_staff(user_id,platform_role) VALUES($1,'SUPER_ADMIN')", [
    root,
  ]);
  const supabase = {
    auth: {
      getUser: async (token: string) => ({
        data: { user: { id: token === 'root' ? root : f[token as 'admin'] } },
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
    { ...poolAdapters(db), supabase: withProviderSessions(db, supabase) },
  );
});
afterAll(async () => db.close());

it('persists gender from combined admission and rejects invalid values without partial family records', async () => {
  const b = payload('GENDER_ADMISSION');
  const invalid = await admit({ ...b, student: { ...b.student, gender: 'INVALID' } });
  expect(invalid.status).toBe(422);
  expect((await call('get', '/resources/students?search=GENDER_ADMISSION')).body.total).toBe(0);
  const r = await admit({ ...b, student: { ...b.student, gender: 'FEMALE' } });
  expect(r.status).toBe(201);
  expect(r.body.student.gender).toBe('FEMALE');
  expect((await call('get', `/students/${r.body.student.id}/overview`)).body.student.gender).toBe(
    'FEMALE',
  );
});
it('accepts two parents but rejects a third through admission and direct family-link APIs', async () => {
  const body = payload('TWO_PARENTS');
  const extra = [1, 2].map((i) => ({
    parent: { full_name: `Limit parent ${i}`, email: `limit-${i}@example.test` },
    relationship: 'FATHER',
  }));
  const invalid = await admit({ ...body, guardians: [...body.guardians, ...extra] });
  expect(invalid.status).toBe(422);
  expect(JSON.stringify(invalid.body)).toContain('at most two');
  const valid = await admit({ ...body, guardians: [...body.guardians, extra[0]] });
  expect(valid.status, JSON.stringify(valid.body)).toBe(201);
  expect(valid.body.connections).toHaveLength(2);
  const parent = (
    await db.query(
      "INSERT INTO parents(school_id,full_name) VALUES($1,'Third limit parent') RETURNING id",
      [f.schoolA],
    )
  ).rows[0].id;
  const link = {
    student_id: valid.body.student.id,
    parent_id: parent,
    relationship: 'GUARDIAN',
    is_primary_contact: false,
    can_receive_alerts: true,
    status: 'ACTIVE',
  };
  const third = await call('post', '/resources/student_parents').send(link);
  expect(third.status).toBe(409);
  expect(third.body.error.code).toBe('STUDENT_PARENT_LIMIT');
  await call('patch', `/resources/student_parents/${valid.body.connections[1].id}`)
    .send({ status: 'REVOKED' })
    .expect(200);
  expect((await call('post', '/resources/student_parents').send(link)).status).toBe(201);
  const reactivated = await call(
    'patch',
    `/resources/student_parents/${valid.body.connections[1].id}`,
  ).send({ status: 'ACTIVE' });
  expect(reactivated.status).toBe(409);
  expect(reactivated.body.error.code).toBe('STUDENT_PARENT_LIMIT');
  expect(
    (
      await db.query("SELECT id FROM student_parents WHERE student_id=$1 AND status='ACTIVE'", [
        valid.body.student.id,
      ])
    ).rows,
  ).toHaveLength(2);
});

it('atomically creates student, enrollment, parent and authorized family connection with audited safe retries', async () => {
  const body = payload('ADM001'),
    key = crypto.randomUUID(),
    r = await admit(body, key);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  expect(r.body.student.student_code).toBe('ADM001');
  expect(r.body.student.gender).toBe('NOT_SPECIFIED');
  expect(r.body.student.date_of_birth.slice(0, 10)).toBe('2012-04-03');
  expect(r.body.enrollment).toMatchObject({
    student_id: r.body.student.id,
    class_id: f.classId,
    academic_session_id: f.session,
    roll_number: 'ADM001',
  });
  expect(r.body.connections[0]).toMatchObject({
    student_id: r.body.student.id,
    parent_id: r.body.parents[0].id,
    relationship: 'MOTHER',
    is_primary_contact: true,
    can_receive_alerts: true,
    status: 'ACTIVE',
  });
  expect((await admit(body, key)).body).toEqual(r.body);
  expect(
    (await admit({ ...body, student: { ...body.student, first_name: 'Changed' } }, key)).status,
  ).toBe(409);
  expect(
    (
      await db.query('SELECT action FROM audit_logs WHERE entity_id=ANY($1::uuid[])', [
        [r.body.student.id, r.body.enrollment.id, r.body.parents[0].id, r.body.connections[0].id],
      ])
    ).rows
      .map((v: any) => v.action)
      .sort(),
  ).toEqual(
    [
      'students.create',
      'enrollments.create',
      'parents.create',
      'student_parents.create',
      'student_parents.insert',
    ].sort(),
  );
  const profile = await call('get', `/students/${r.body.student.id}/overview`);
  expect(profile.body.student.email).toBe(body.student.email);
  expect(profile.body.parents[0].full_name).toBe(body.guardians[0].parent.full_name);
  expect(profile.body.enrollment.roll_number).toBe('ADM001');
});
it('reuses one parent for siblings and immediately enforces access and revoked links', async () => {
  const b = payload('SIBLING');
  const r = await admit({
    ...b,
    guardians: [
      {
        parent_id: f.parentId,
        relationship: 'FATHER',
        is_primary_contact: true,
        can_receive_alerts: false,
      },
    ],
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  expect(r.body.parents[0].id).toBe(f.parentId);
  expect((await call('get', `/students/${r.body.student.id}/overview`, 'parent')).status).toBe(200);
  expect((await call('get', `/students/${r.body.student.id}/overview`, 'studentUser')).status).toBe(
    404,
  );
  expect(
    (
      await call('patch', '/resources/student_parents/' + r.body.connections[0].id).send({
        status: 'REVOKED',
      })
    ).status,
  ).toBe(200);
  expect((await call('get', `/students/${r.body.student.id}/overview`, 'parent')).status).toBe(404);
});
it('rolls back all new rows and audits when the second parent is invalid or duplicate', async () => {
  const before = (await db.query("SELECT id FROM audit_logs WHERE action<>'access.denied'")).rows
      .length,
    b = payload('ROLLBACK');
  const r = await admit({
    ...b,
    guardians: [...b.guardians, { parent_id: crypto.randomUUID(), relationship: 'FATHER' }],
  });
  expect(r.status).toBe(404);
  for (const table of ['students', 'parents'])
    expect(
      (
        await db.query(
          `SELECT id FROM ${table} WHERE ${table === 'students' ? 'student_code' : 'full_name'}=$1`,
          [table === 'students' ? 'ROLLBACK' : 'Guardian ROLLBACK'],
        )
      ).rows,
    ).toHaveLength(0);
  expect(
    (await db.query("SELECT id FROM audit_logs WHERE action<>'access.denied'")).rows,
  ).toHaveLength(before);
  const duplicate = await admit({
    ...b,
    guardians: [
      ...b.guardians,
      {
        parent: { full_name: 'Duplicate parent', email: b.guardians[0].parent.email.toUpperCase() },
        relationship: 'FATHER',
      },
    ],
  });
  expect(duplicate.status).toBe(409);
  expect(
    (await db.query("SELECT id FROM students WHERE student_code='ROLLBACK'")).rows,
  ).toHaveLength(0);
});
it('rejects duplicate student codes and existing parent emails rather than silently duplicating or merging records', async () => {
  expect((await admit(payload('ADM001'))).status).toBe(409);
  const b = payload('PARENT_DUP'),
    r = await admit({
      ...b,
      guardians: [
        {
          ...b.guardians[0],
          parent: { full_name: 'Changed name', email: 'PARENT@example.invalid' },
        },
      ],
    });
  expect(r.status).toBe(409);
  expect(r.body.error.code).toBe('PARENT_EXISTS');
  expect(
    (await db.query("SELECT id FROM students WHERE student_code='PARENT_DUP'")).rows,
  ).toHaveLength(0);
});
it('validates complete families, untrusted fields, dates and retry keys before writing', async () => {
  const b = payload('INVALID');
  for (const body of [
    { ...b, guardians: [] },
    { ...b, enrollment: { ...b.enrollment, ends_on: '2020-01-01' } },
    { ...b, student: { ...b.student, user_id: f.admin } },
    { ...b, guardians: [{ ...b.guardians[0], parent_id: f.parentId }] },
    {
      ...b,
      guardians: [
        { parent_id: f.parentId, relationship: 'FATHER', is_primary_contact: true },
        { parent_id: f.parentId, relationship: 'MOTHER', is_primary_contact: true },
      ],
    },
  ])
    expect((await admit(body)).status).toBe(422);
  expect((await call('post', '/student-directory/admissions').send(b)).status).toBe(422);
});
it('denies other roles, foreign schools and inactive parents without exposing or changing their records', async () => {
  const b = payload('DENIED');
  for (const role of ['teacher', 'principal', 'parent', 'studentUser', 'root']) {
    for (const path of [
      '/student-directory/classes',
      '/student-directory/students?unassigned=1',
      '/student-directory/parents',
      '/student-directory/enrollment-classes',
    ])
      expect([403, 404]).toContain((await call('get', path, role)).status);
    expect([403, 404]).toContain(
      (
        await call('post', '/student-directory/admissions', role)
          .set('Idempotency-Key', crypto.randomUUID())
          .send(b)
      ).status,
    );
  }
  expect(
    (await call('get', '/student-directory/classes').set('X-School-Id', f.schoolB)).status,
  ).toBe(404);
  expect(
    (await admit({ ...b, enrollment: { ...b.enrollment, class_id: crypto.randomUUID() } })).status,
  ).toBe(404);
  const foreign = (
    await db.query<{ id: string }>(
      "INSERT INTO parents(school_id,full_name) VALUES($1,'Foreign guardian') RETURNING id",
      [f.schoolB],
    )
  ).rows[0].id;
  expect(
    (await admit({ ...b, guardians: [{ parent_id: foreign, relationship: 'GUARDIAN' }] })).status,
  ).toBe(404);
  await db.query("UPDATE parents SET status='INACTIVE' WHERE id=$1", [f.parentId]);
  try {
    expect(
      (await admit({ ...b, guardians: [{ parent_id: f.parentId, relationship: 'GUARDIAN' }] }))
        .status,
    ).toBe(404);
    expect(
      (await call('get', '/student-directory/parents')).body.data.some(
        (p: any) => p.id === f.parentId,
      ),
    ).toBe(false);
  } finally {
    await db.query("UPDATE parents SET status='ACTIVE' WHERE id=$1", [f.parentId]);
  }
});
it('enforces subscription and student quota without orphan family or enrollment rows', async () => {
  await db.query("UPDATE subscriptions SET status='EXPIRED' WHERE school_id=$1", [f.schoolA]);
  try {
    expect((await admit(payload('QUOTA'))).status).toBe(403);
  } finally {
    await db.query("UPDATE subscriptions SET status='ACTIVE' WHERE school_id=$1", [f.schoolA]);
  }
  const old = (
    await db.query('SELECT limit_overrides FROM subscriptions WHERE school_id=$1', [f.schoolA])
  ).rows[0].limit_overrides;
  await db.query(
    "UPDATE subscriptions SET limit_overrides=coalesce(limit_overrides,'{}'::jsonb)||'{\"max_students\":0}'::jsonb WHERE school_id=$1",
    [f.schoolA],
  );
  try {
    expect((await admit(payload('QUOTA'))).body.error.code).toBe('PLAN_LIMIT_REACHED');
  } finally {
    await db.query('UPDATE subscriptions SET limit_overrides=$2 WHERE school_id=$1', [
      f.schoolA,
      old,
    ]);
  }
  expect((await db.query("SELECT id FROM students WHERE student_code='QUOTA'")).rows).toHaveLength(
    0,
  );
});
it('matches class counts to paged rosters, preserves unassigned/future/former/inactive students and validates class scope', async () => {
  for (const [code, start, end, status] of [
    ['FUTURE', '2099-01-01', null, 'ACTIVE'],
    ['ENDED', '2010-01-01', '2011-01-01', 'ENDED'],
    ['INACTIVE', '2026-01-01', null, 'ACTIVE'],
  ] as const) {
    const s = (
      await db.query<{ id: string }>(
        'INSERT INTO students(school_id,student_code,first_name,status) VALUES($1,$2,$2,$3) RETURNING id',
        [f.schoolA, code, code === 'INACTIVE' ? 'WITHDRAWN' : 'ACTIVE'],
      )
    ).rows[0].id;
    await db.query(
      'INSERT INTO enrollments(school_id,student_id,class_id,academic_session_id,starts_on,ends_on,status) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [f.schoolA, s, f.classId, f.session, start, end, status],
    );
  }
  const classes = await call('get', '/student-directory/classes'),
    roster = await call('get', '/student-directory/students?class_id=' + f.classId);
  expect(classes.body.data.find((c: any) => c.id === f.classId).student_count).toBe(
    roster.body.total,
  );
  expect(classes.body.unassigned_count).toBe(2);
  expect(roster.body.data.map((s: any) => s.student_code)).toContain('INACTIVE');
  expect(
    (await call('get', '/student-directory/students?unassigned=1')).body.data
      .map((s: any) => s.student_code)
      .sort(),
  ).toEqual(['ENDED', 'FUTURE']);
  expect(
    (await call('get', '/student-directory/students?unassigned=1&search=FUTURE')).body.total,
  ).toBe(1);
  const page = await call(
    'get',
    '/student-directory/students?class_id=' + f.classId + '&page_size=1&page=2',
  );
  expect(page.body.data).toHaveLength(1);
  expect(page.body.total).toBe(roster.body.total);
  expect(
    (await call('get', '/student-directory/students?class_id=' + crypto.randomUUID())).status,
  ).toBe(404);
  expect((await call('get', '/student-directory/students')).status).toBe(422);
  expect(
    (await call('get', '/student-directory/students?class_id=' + f.classId + '&unassigned=1'))
      .status,
  ).toBe(422);
  expect((await call('get', '/student-directory/classes?page_size=10000')).status).toBe(422);
});
