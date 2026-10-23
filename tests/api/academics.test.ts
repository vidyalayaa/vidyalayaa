import { fixtureBearer, withProviderSessions } from '../helpers/provider-sessions.js';
import { beforeAll, afterAll, it, expect } from 'vitest';
import request from 'supertest';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { portableDatabase, poolAdapters, fixture } from '../helpers/database.js';
import { createApp } from '../../apps/api/src/app.js';
import type { Config } from '../../apps/api/src/lib/config.js';

let db: PGlite, f: Awaited<ReturnType<typeof fixture>>, app: ReturnType<typeof createApp>;
let b: string,
  empty: string,
  teacher2: string,
  english: string,
  student2: string,
  foreignClass: string;
const call = (method: 'get' | 'post' | 'patch', path: string, role = 'admin') =>
  request(app)
    [method]('/api/v1' + path)
    .set('Authorization', 'Bearer ' + fixtureBearer(role))
    .set('X-School-Id', f.schoolA);
const create = async (name: string, body: unknown) => {
  const r = await call('post', '/resources/' + name).send(body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
};
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
    { ...poolAdapters(db), supabase: withProviderSessions(db, auth) },
  );
  teacher2 = (
    await create('teachers', { staff_code: 'ACADEMIC_T2', full_name: 'Academic second teacher' })
  ).id;
  b = (
    await create('classes', {
      academic_session_id: f.session,
      grade: '8',
      section: 'B',
      class_teacher_id: teacher2,
    })
  ).id;
  empty = (
    await create('classes', {
      academic_session_id: f.session,
      grade: '10',
      section: 'C',
      class_teacher_id: teacher2,
    })
  ).id;
  english = (await create('subjects', { code: 'ACADEMIC_ENG', name: 'Academic English' })).id;
  await create('teacher_class_assignments', {
    teacher_id: teacher2,
    class_id: f.classId,
    subject_id: f.subject,
    starts_on: '2026-01-01',
  });
  await create('teacher_class_assignments', {
    teacher_id: f.teacherId,
    class_id: b,
    subject_id: english,
    starts_on: '2026-01-01',
  });
  student2 = (
    await create('students', { student_code: 'ACADEMIC_B', first_name: 'Section B learner' })
  ).id;
  await create('enrollments', {
    student_id: student2,
    class_id: b,
    academic_session_id: f.session,
    starts_on: '2026-01-01',
  });
  for (const [code, status, starts, ends, enrollmentStatus] of [
    ['FUTURE', 'ACTIVE', '2099-01-01', null, 'ACTIVE'],
    ['ENDED', 'ACTIVE', '2010-01-01', '2011-01-01', 'ENDED'],
    ['WITHDRAWN', 'WITHDRAWN', '2026-01-01', null, 'ACTIVE'],
  ]) {
    const student = (
      await db.query<{ id: string }>(
        'INSERT INTO students(school_id,student_code,first_name,status) VALUES($1,$2,$2,$3) RETURNING id',
        [f.schoolA, code, status],
      )
    ).rows[0].id;
    await db.query(
      'INSERT INTO enrollments(school_id,student_id,class_id,academic_session_id,starts_on,ends_on,status) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [f.schoolA, student, f.classId, f.session, starts, ends, enrollmentStatus],
    );
  }
  const foreignSession = (
    await db.query<{ id: string }>(
      "INSERT INTO academic_sessions(school_id,name,starts_on,ends_on) VALUES($1,'Foreign year','2026-01-01','2027-12-31') RETURNING id",
      [f.schoolB],
    )
  ).rows[0].id;
  foreignClass = (
    await db.query<{ id: string }>(
      "INSERT INTO classes(school_id,academic_session_id,grade,section) VALUES($1,$2,'FOREIGN','Z') RETURNING id",
      [f.schoolB, foreignSession],
    )
  ).rows[0].id;
});
afterAll(async () => db.close());

it('counts recorded sex in the correct section and excludes future, ended and inactive students', async () => {
  const section = await create('classes', {
    academic_session_id: f.session,
    grade: '11',
    section: 'SEX_COUNTS',
    class_teacher_id: teacher2,
  });
  const ids: string[] = [];
  for (const [code, sex, status, starts_on] of [
    ['SEX_M', 'MALE', 'ACTIVE', '2026-01-01'],
    ['SEX_F', 'FEMALE', 'ACTIVE', '2026-01-01'],
    ['SEX_O', 'OTHER', 'ACTIVE', '2026-01-01'],
    ['SEX_U', 'NOT_SPECIFIED', 'ACTIVE', '2026-01-01'],
    ['SEX_FUTURE', 'MALE', 'ACTIVE', '2099-01-01'],
    ['SEX_WITHDRAWN', 'FEMALE', 'WITHDRAWN', '2026-01-01'],
  ]) {
    const student = await create('students', { student_code: code, first_name: code, sex, status });
    ids.push(student.id);
    await create('enrollments', {
      student_id: student.id,
      class_id: section.id,
      academic_session_id: f.session,
      starts_on,
    });
  }
  const stats = async () =>
    (await call('get', '/academics/classes')).body.data.find((c: any) => c.id === section.id);
  expect(await stats()).toMatchObject({
    student_count: 4,
    male_count: 1,
    female_count: 1,
    other_count: 1,
    unspecified_count: 1,
  });
  expect((await call('patch', '/resources/students/' + ids[1]).send({ sex: 'MALE' })).status).toBe(
    200,
  );
  expect(await stats()).toMatchObject({
    student_count: 4,
    male_count: 2,
    female_count: 0,
    other_count: 1,
    unspecified_count: 1,
  });
  const invalid = await call('patch', '/resources/students/' + ids[0]).send({ sex: 'INVALID' });
  expect(invalid.status).toBe(422);
  expect(
    (await call('patch', '/resources/students/' + ids[0], 'teacher').send({ sex: 'FEMALE' }))
      .status,
  ).toBe(403);
  expect(
    (await call('patch', '/resources/students/' + f.foreignStudent).send({ sex: 'FEMALE' })).status,
  ).toBe(404);
  await expect(db.query("UPDATE students SET sex='INVALID' WHERE id=$1", [ids[0]])).rejects.toThrow(
    /students_sex_check/,
  );
  // Retire this isolated section so the existing pagination/group assertions remain stable.
  await db.query('UPDATE classes SET retired_at=now() WHERE id=$1', [section.id]);
});

it('groups existing classes with accurate student, distinct-subject and Class Teacher data without writing records', async () => {
  const before = (await db.query('SELECT id FROM teacher_class_assignments ORDER BY id')).rows;
  const r = await call('get', '/academics/classes');
  expect(r.status).toBe(200);
  expect(r.body.data).toHaveLength(3);
  expect(r.body.data.find((c: any) => c.id === f.classId)).toMatchObject({
    grade: '8',
    section: 'A',
    student_count: 1,
    male_count: 0,
    female_count: 0,
    other_count: 0,
    unspecified_count: 1,
    subject_count: 1,
    assignment_count: 2,
    class_teacher_id: f.teacherId,
    class_teacher_label: 'Teacher Test',
  });
  expect(r.body.data.find((c: any) => c.id === b)).toMatchObject({
    student_count: 1,
    subject_count: 1,
    class_teacher_id: teacher2,
  });
  expect(r.body.data.find((c: any) => c.id === empty)).toMatchObject({
    student_count: 0,
    subject_count: 0,
  });
  expect(r.body.sessions.map((s: any) => s.id)).toContain(f.session);
  expect((await db.query('SELECT id FROM teacher_class_assignments ORDER BY id')).rows).toEqual(
    before,
  );
});

it('shows the same subject once with every assigned teacher and scopes each section correctly', async () => {
  const a = await call('get', `/academics/classes/${f.classId}/subjects`),
    other = await call('get', `/academics/classes/${b}/subjects`);
  expect(a.status).toBe(200);
  expect(a.body.total).toBe(1);
  expect(a.body.data[0]).toMatchObject({ id: f.subject, code: 'MAT' });
  expect(a.body.data[0].teachers.map((t: any) => t.teacher_id).sort()).toEqual(
    [f.teacherId, teacher2].sort(),
  );
  expect(
    a.body.data[0].teachers.every(
      (t: any) => t.class_id === f.classId && t.subject_id === f.subject,
    ),
  ).toBe(true);
  expect(other.body.data.map((s: any) => s.id)).toEqual([english]);
});

it('uses matching dated active enrollment rules for counts and lists while retaining history', async () => {
  const current = await call('get', `/academics/classes/${f.classId}/enrollments`);
  expect(current.body.total).toBe(1);
  expect(current.body.data[0].student_id).toBe(f.student);
  const all = await call('get', `/academics/classes/${f.classId}/enrollments?view=all`);
  expect(all.body.total).toBe(4);
  expect(all.body.data.every((e: any) => e.class_id === f.classId)).toBe(true);
  expect(
    (await call('get', `/academics/classes/${b}/enrollments`)).body.data.map(
      (e: any) => e.student_id,
    ),
  ).toEqual([student2]);
  expect((await call('get', `/academics/classes/${f.classId}/enrollments?view=bogus`)).status).toBe(
    422,
  );
});

it('paginates complete class, subject and enrollment results and validates query identifiers', async () => {
  const pages = await Promise.all(
    [1, 2, 3].map((page) => call('get', `/academics/classes?page_size=1&page=${page}`)),
  );
  expect(new Set(pages.flatMap((p) => p.body.data.map((c: any) => c.id))).size).toBe(3);
  expect(pages.every((p) => p.body.total === 3)).toBe(true);
  expect(
    (await call('get', '/academics/classes?session_id=' + crypto.randomUUID())).body.total,
  ).toBe(0);
  expect((await call('get', '/academics/classes?session_id=bad')).status).toBe(422);
  expect((await call('get', '/academics/classes?page_size=10000')).status).toBe(422);
  const second = await call(
    'get',
    `/academics/classes/${f.classId}/enrollments?view=all&page_size=2&page=2`,
  );
  expect(second.body.total).toBe(4);
  expect(second.body.data).toHaveLength(2);
});

it('rejects non-admin roles and foreign classes without exposing student or assignment data', async () => {
  for (const role of ['teacher', 'principal', 'parent', 'studentUser']) {
    for (const path of [
      '/academics/classes',
      `/academics/classes/${f.classId}/subjects`,
      `/academics/classes/${f.classId}/enrollments`,
      `/academics/classes/${f.classId}/unconfigured-assignments`,
    ])
      expect((await call('get', path, role)).status, role + path).toBe(403);
  }
  for (const suffix of ['subjects', 'enrollments', 'unconfigured-assignments']) {
    const foreign = await call('get', `/academics/classes/${foreignClass}/${suffix}`),
      missing = await call('get', `/academics/classes/${crypto.randomUUID()}/${suffix}`);
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(foreign.body.error.code).toBe(missing.body.error.code);
  }
  expect((await call('get', '/academics/classes').set('X-School-Id', f.schoolB)).status).toBe(404);
});

it('reuses class and enrollment CRUD, prevents duplicates, and archives without deleting history', async () => {
  const c = await create('classes', {
    academic_session_id: f.session,
    grade: '7',
    section: 'CRUD',
    class_teacher_id: f.teacherId,
  });
  expect(
    (
      await call('post', '/resources/classes').send({
        academic_session_id: f.session,
        grade: '7',
        section: 'CRUD',
        class_teacher_id: f.teacherId,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await call('patch', '/resources/classes/' + c.id).send({
        section: 'CRUD_EDIT',
        class_teacher_id: teacher2,
      })
    ).status,
  ).toBe(200);
  const learner = await create('students', {
    student_code: 'ACADEMIC_CRUD',
    first_name: 'Enrollment CRUD learner',
  });
  const e = await create('enrollments', {
    student_id: learner.id,
    class_id: c.id,
    academic_session_id: f.session,
    starts_on: '2026-01-01',
    roll_number: '7',
  });
  expect(
    (await call('get', `/academics/classes/${c.id}/enrollments`)).body.data[0].roll_number,
  ).toBe('7');
  expect(
    (
      await call('post', `/resources/classes/${c.id}/retire`).send({
        reason: 'Keep active enrollment protected',
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await call('patch', `/resources/enrollments/${e.id}`).send({
        status: 'ENDED',
        roll_number: '8',
      })
    ).status,
  ).toBe(200);
  expect((await call('get', `/academics/classes/${c.id}/enrollments`)).body.total).toBe(0);
  expect(
    (await call('get', `/academics/classes/${c.id}/enrollments?view=all`)).body.data[0].roll_number,
  ).toBe('8');
  expect(
    (
      await call('post', `/resources/classes/${c.id}/retire`).send({
        reason: 'Archive completed test section',
      })
    ).status,
  ).toBe(204);
  expect((await db.query('SELECT id FROM enrollments WHERE id=$1', [e.id])).rows).toHaveLength(1);
  expect(
    (await call('get', '/academics/classes')).body.data.some((row: any) => row.id === c.id),
  ).toBe(false);
});

it('reuses subject and teacher-assignment CRUD without duplicating subjects or removing another section mapping', async () => {
  const sub = await create('subjects', { code: 'ACADEMIC_CRUD', name: 'Subject CRUD' });
  expect(
    (
      await call('post', '/resources/subjects').send({
        code: 'ACADEMIC_CRUD',
        name: 'Duplicate catalogue subject',
      })
    ).status,
  ).toBe(409);
  const body = {
    teacher_id: f.teacherId,
    class_id: f.classId,
    subject_id: sub.id,
    starts_on: '2026-01-01',
  };
  const first = await create('teacher_class_assignments', body);
  expect((await call('post', '/resources/teacher_class_assignments').send(body)).status).toBe(409);
  const second = await create('teacher_class_assignments', { ...body, teacher_id: teacher2 });
  await create('teacher_class_assignments', { ...body, class_id: b });
  expect(
    (await call('patch', '/resources/subjects/' + sub.id).send({ name: 'Edited shared subject' }))
      .status,
  ).toBe(200);
  expect(
    (
      await call('patch', '/resources/teacher_class_assignments/' + first.id).send({
        ends_on: '2027-12-31',
      })
    ).status,
  ).toBe(200);
  const current = (await call('get', `/academics/classes/${f.classId}/subjects`)).body.data.find(
    (s: any) => s.id === sub.id,
  );
  expect(current.name).toBe('Edited shared subject');
  expect(current.teachers).toHaveLength(2);
  for (const id of [first.id, second.id])
    expect(
      (
        await call('post', `/resources/teacher_class_assignments/${id}/retire`).send({
          reason: 'Remove only this section teaching assignment',
        })
      ).status,
    ).toBe(204);
  expect(
    (await call('get', `/academics/classes/${f.classId}/subjects`)).body.data.some(
      (s: any) => s.id === sub.id,
    ),
  ).toBe(false);
  expect(
    (await call('get', `/academics/classes/${b}/subjects`)).body.data.some(
      (s: any) => s.id === sub.id,
    ),
  ).toBe(true);
  expect((await db.query('SELECT id FROM subjects WHERE id=$1', [sub.id])).rows).toHaveLength(1);
});

it('saves a section subject and required teacher atomically, with safe retries and independent sibling assignments', async () => {
  const path = `/academics/classes/${empty}/subjects`;
  const body = {
    subject: { code: 'ATOMIC_SUB', name: 'Atomic section subject' },
    teacher_id: f.teacherId,
    starts_on: '2026-01-01',
  };
  const first = await call('post', path).set('Idempotency-Key', 'atomic-subject-001').send(body);
  expect(first.status, JSON.stringify(first.body)).toBe(201);
  expect(first.body.assignment).toMatchObject({
    class_id: empty,
    teacher_id: f.teacherId,
    subject_id: first.body.subject.id,
  });
  const retry = await call('post', path).set('Idempotency-Key', 'atomic-subject-001').send(body);
  expect(retry.status).toBe(201);
  expect(retry.body).toEqual(first.body);
  expect(
    (
      await call('post', path)
        .set('Idempotency-Key', 'atomic-subject-001')
        .send({ ...body, teacher_id: teacher2 })
    ).status,
  ).toBe(409);
  expect(
    (await call('get', `/academics/classes/${b}/subjects`)).body.data.some(
      (s: any) => s.id === first.body.subject.id,
    ),
  ).toBe(false);
  const sibling = await call('post', `/academics/classes/${b}/subjects`).send({
    subject_id: first.body.subject.id,
    teacher_id: teacher2,
    starts_on: '2026-01-01',
  });
  expect(sibling.status, JSON.stringify(sibling.body)).toBe(201);
  expect(sibling.body.assignment.class_id).toBe(b);
  const own = (await call('get', path)).body.data.find((s: any) => s.id === first.body.subject.id);
  expect(own.teachers.map((t: any) => t.teacher_id)).toEqual([f.teacherId]);
  expect(
    (
      await call('post', path).send({
        subject_id: first.body.subject.id,
        teacher_id: f.teacherId,
        starts_on: '2026-01-01',
      })
    ).status,
  ).toBe(409);
  expect(
    (await db.query('SELECT id FROM subjects WHERE code=$1', ['ATOMIC_SUB'])).rows,
  ).toHaveLength(1);
});

it('rejects missing, invalid or inactive teachers and rolls back the subject and audit on failure', async () => {
  const path = `/academics/classes/${empty}/subjects`;
  const body = {
    subject: { code: 'ATOMIC_ROLLBACK', name: 'Must not survive' },
    starts_on: '2026-01-01',
  };
  const before = (await db.query('SELECT id FROM audit_logs')).rows.length;
  expect((await call('post', path).send(body)).status).toBe(422);
  const bad = await call('post', path).send({ ...body, teacher_id: crypto.randomUUID() });
  expect(bad.status, JSON.stringify(bad.body)).toBe(422);
  const inactive = await create('teachers', {
    staff_code: 'ACA_INACTIVE',
    full_name: 'Inactive teacher',
    status: 'INACTIVE',
  });
  const auditCount = (await db.query('SELECT id FROM audit_logs')).rows.length;
  expect(auditCount).toBeGreaterThan(before);
  expect((await call('post', path).send({ ...body, teacher_id: inactive.id })).status).toBe(422);
  expect(
    (await call('post', path).send({ ...body, teacher_id: f.teacherId, subject_id: f.subject }))
      .status,
  ).toBe(422);
  expect(
    (await db.query('SELECT id FROM subjects WHERE code=$1', ['ATOMIC_ROLLBACK'])).rows,
  ).toHaveLength(0);
  expect((await db.query('SELECT id FROM audit_logs')).rows).toHaveLength(auditCount);
});

it('enforces role, school, subject ownership and subscription checks on atomic subject writes', async () => {
  const path = `/academics/classes/${empty}/subjects`;
  const body = { subject_id: english, teacher_id: teacher2, starts_on: '2026-01-01' };
  for (const role of ['teacher', 'principal', 'parent', 'studentUser'])
    expect((await call('post', path, role).send(body)).status).toBe(403);
  expect(
    (await call('post', `/academics/classes/${foreignClass}/subjects`).send(body)).status,
  ).toBe(404);
  expect((await call('post', path).send({ ...body, subject_id: crypto.randomUUID() })).status).toBe(
    404,
  );
  const foreignSubject = (
    await db.query<{ id: string }>(
      'INSERT INTO subjects(school_id,code,name) VALUES($1,$2,$3) RETURNING id',
      [f.schoolB, 'FOREIGN_ATOMIC', 'Foreign subject'],
    )
  ).rows[0].id;
  expect((await call('post', path).send({ ...body, subject_id: foreignSubject })).status).toBe(404);
  await db.query("UPDATE subscriptions SET status='EXPIRED' WHERE school_id=$1", [f.schoolA]);
  try {
    expect((await call('post', path).send(body)).status).toBe(403);
  } finally {
    await db.query("UPDATE subscriptions SET status='ACTIVE' WHERE school_id=$1", [f.schoolA]);
  }
});

it('surfaces preserved legacy assignments inside their section and repairs the same row', async () => {
  // Recreate a pre-upgrade row only in this disposable test database.
  await db.exec(
    'ALTER TABLE teacher_class_assignments DROP CONSTRAINT assignment_subject_required',
  );
  let legacy: string;
  try {
    legacy = (
      await db.query<{ id: string }>(
        "INSERT INTO teacher_class_assignments(school_id,teacher_id,class_id,starts_on) VALUES($1,$2,$3,'2026-01-01') RETURNING id",
        [f.schoolA, teacher2, b],
      )
    ).rows[0].id;
  } finally {
    await db.exec(
      'ALTER TABLE teacher_class_assignments ADD CONSTRAINT assignment_subject_required CHECK(subject_id IS NOT NULL OR retired_at IS NOT NULL) NOT VALID',
    );
  }
  const before = await call('get', `/academics/classes/${b}/unconfigured-assignments`);
  expect(before.body.data.map((r: any) => r.id)).toEqual([legacy!]);
  expect(
    (await call('get', '/academics/classes')).body.data.find((c: any) => c.id === b)
      .legacy_assignment_count,
  ).toBe(1);
  expect(
    (
      await call('patch', '/resources/teacher_class_assignments/' + legacy!).send({
        subject_id: english,
      })
    ).status,
  ).toBe(200);
  expect((await call('get', `/academics/classes/${b}/unconfigured-assignments`)).body.total).toBe(
    0,
  );
  expect(
    (await db.query('SELECT subject_id FROM teacher_class_assignments WHERE id=$1', [legacy!]))
      .rows[0].subject_id,
  ).toBe(english);
});
