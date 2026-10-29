import { beforeAll, afterAll, it, expect } from 'vitest';
import request from 'supertest';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { portableDatabase, poolAdapters, fixture } from '../helpers/database.js';
import { fixtureBearer, withProviderSessions } from '../helpers/provider-sessions.js';
import { createApp } from '../../apps/api/src/app.js';
import { transaction } from '../../apps/api/src/lib/db.js';
import type { Config } from '../../apps/api/src/lib/config.js';
let db: PGlite,
  f: Awaited<ReturnType<typeof fixture>>,
  pools: ReturnType<typeof poolAdapters>,
  app: ReturnType<typeof createApp>,
  otherClass: string,
  otherSubject: string,
  legacy: string;
const call = (method: 'get' | 'post' | 'patch', path: string, role = 'admin') =>
  request(app)
    [method]('/api/v1' + path)
    .set('Authorization', 'Bearer ' + fixtureBearer(role))
    .set('X-School-Id', f.schoolA);
async function create(name: string, body: Record<string, unknown>) {
  const r = await call('post', '/resources/' + name).send(body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}
beforeAll(async () => {
  db = await portableDatabase();
  f = await fixture(db);
  pools = poolAdapters(db);
  const users: Record<string, string> = {
    admin: f.admin,
    teacher: f.teacher,
    parent: f.parent,
    student: f.studentUser,
    principal: f.principal,
  };
  const auth = {
    auth: {
      getUser: async (token: string) => ({ data: { user: { id: users[token] } }, error: null }),
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
  otherClass = await create('classes', {
    academic_session_id: f.session,
    grade: '3',
    section: 'OTHER',
    class_teacher_id: f.teacherId,
  });
  otherSubject = await create('subjects', { code: 'CLASS_3_EN', name: 'Class 3 English' });
  await create('teacher_class_assignments', {
    teacher_id: f.teacherId,
    class_id: otherClass,
    subject_id: otherSubject,
    starts_on: '2026-01-01',
  });
  legacy = await create('subjects', { code: 'UNASSIGNED_LEGACY', name: 'Unassigned legacy' });
});
afterAll(async () => db.close());
it('class subject choices omit another class subjects and admit only same-class records or unassigned legacy catalogue records', async () => {
  const choices = (
    await call('get', `/academics/classes/${f.classId}/subject-choices`)
  ).body.data.map((r: any) => r.id);
  expect(choices).toContain(f.subject);
  expect(choices).toContain(legacy);
  expect(choices).not.toContain(otherSubject);
  const other = (
    await call('get', `/academics/classes/${otherClass}/subject-choices`)
  ).body.data.map((r: any) => r.id);
  expect(other).toContain(otherSubject);
  expect(other).not.toContain(f.subject);
  const r = await call('post', `/academics/classes/${f.classId}/subjects`).send({
    subject_id: otherSubject,
    teacher_id: f.teacherId,
    starts_on: '2026-01-01',
  });
  expect(r.status).toBe(422);
  expect(r.body.error.code).toBe('CLASS_SUBJECT_REQUIRED');
  expect(
    (await call('get', `/academics/classes/${f.classId}/subjects`)).body.data.map((r: any) => r.id),
  ).toEqual([f.subject]);
});
it('a new subject stays in the class where it was created and cannot be selected by another class', async () => {
  const r = await call('post', `/academics/classes/${f.classId}/subjects`).send({
    subject: { code: 'CLASS_2_ONLY', name: 'Class 2 only' },
    teacher_id: f.teacherId,
    starts_on: '2026-01-01',
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  expect(
    (await call('get', `/academics/classes/${otherClass}/subject-choices`)).body.data.map(
      (s: any) => s.id,
    ),
  ).not.toContain(r.body.subject.id);
  expect(
    (
      await call('post', `/academics/classes/${otherClass}/subjects`).send({
        subject_id: r.body.subject.id,
        teacher_id: f.teacherId,
        starts_on: '2026-01-01',
      })
    ).status,
  ).toBe(422);
  const reuse = await call('post', `/academics/classes/${f.classId}/subjects`).send({
    subject_id: legacy,
    teacher_id: f.teacherId,
    starts_on: '2026-01-01',
  });
  expect(reuse.status).toBe(201);
  expect(
    (await call('get', `/academics/classes/${otherClass}/subject-choices`)).body.data.map(
      (s: any) => s.id,
    ),
  ).not.toContain(legacy);
});
it('rejects another class homework subject in API and direct SQL while preserving same-class homework', async () => {
  const body = {
    class_id: f.classId,
    subject_id: otherSubject,
    kind: 'HOMEWORK',
    title: 'Wrong class subject',
  };
  const r = await call('post', '/resources/assignments').send(body);
  expect(r.status).toBe(422);
  expect(r.body.error.code).toBe('CLASS_SUBJECT_REQUIRED');
  await expect(
    transaction(pools.api, { schoolId: f.schoolA, userId: f.admin }, (tx) =>
      tx.query(
        "INSERT INTO assignments(school_id,class_id,subject_id,kind,title,created_by) VALUES($1,$2,$3,'HOMEWORK','Wrong class',$4)",
        [f.schoolA, f.classId, otherSubject, f.admin],
      ),
    ),
  ).rejects.toThrow(/CLASS_SUBJECT_REQUIRED/);
  const valid = await create('assignments', {
    ...body,
    subject_id: f.subject,
    title: 'Class 2 homework',
  });
  expect(
    (await call('patch', '/resources/assignments/' + valid).send({ subject_id: otherSubject }))
      .status,
  ).toBe(409);
  expect((await call('get', '/resources/assignments/' + valid)).body.subject_id).toBe(f.subject);
});
it('student subject lists and direct database reads contain only subjects mapped to their own current class', async () => {
  const r = await call('get', '/resources/subjects', 'student');
  expect(r.status).toBe(200);
  expect(r.body.data.map((s: any) => s.id)).not.toContain(otherSubject);
  expect(r.body.data.map((s: any) => s.id)).toContain(f.subject);
  await transaction(pools.api, { schoolId: f.schoolA, userId: f.studentUser }, async (tx) =>
    expect((await tx.query('SELECT id FROM subjects')).rows.map((s) => s.id)).not.toContain(
      otherSubject,
    ),
  );
  expect((await call('get', '/resources/subjects?class_id=' + otherClass, 'student')).status).toBe(
    404,
  );
  for (const role of ['student', 'parent', 'teacher', 'principal'])
    expect(
      (await call('get', `/academics/classes/${f.classId}/subject-choices`, role)).status,
    ).toBe(403);
  expect(
    (await call('get', `/academics/classes/${crypto.randomUUID()}/subject-choices`)).status,
  ).toBe(404);
});
it('a Class Teacher who teaches another class sees only the selected class subjects for official marks', async () => {
  const r = await call(
    'get',
    `/resources/subjects?class_id=${f.classId}&assessment_kind=OFFICIAL`,
    'teacher',
  );
  expect(r.status).toBe(200);
  expect(r.body.data.map((s: any) => s.id)).toContain(f.subject);
  expect(r.body.data.map((s: any) => s.id)).not.toContain(otherSubject);
});
it('rejects tampered examinations and official marks that use another class subject in API and database writes', async () => {
  const invalid = await call('post', '/resources/exams').send({
    class_id: f.classId,
    subject_id: otherSubject,
    name: 'Wrong class test',
    assessment_kind: 'SUBJECT_TEST',
    exam_type: 'UNIT',
    max_score: 100,
    status: 'OPEN',
  });
  expect(invalid.status).toBe(409);
  const exam = await create('exams', {
    class_id: f.classId,
    name: 'Official class examination',
    assessment_kind: 'OFFICIAL',
    exam_type: 'FINAL',
    max_score: 100,
    status: 'OPEN',
  });
  const mark = await call('post', '/resources/marks', 'teacher').send({
    exam_id: exam,
    student_id: f.student,
    subject_id: otherSubject,
    score: 80,
  });
  expect(mark.status).toBe(409);
  await expect(
    transaction(pools.api, { schoolId: f.schoolA, userId: f.admin }, (tx) =>
      tx.query(
        'INSERT INTO marks(school_id,exam_id,student_id,subject_id,score,entered_by) VALUES($1,$2,$3,$4,80,$5)',
        [f.schoolA, exam, f.student, otherSubject, f.admin],
      ),
    ),
  ).rejects.toThrow(/CLASS_SUBJECT_REQUIRED/);
  expect(
    (
      await call('post', '/resources/marks', 'teacher').send({
        exam_id: exam,
        student_id: f.student,
        subject_id: f.subject,
        score: 80,
      })
    ).status,
  ).toBe(201);
});
