import { beforeAll, afterAll, it, expect } from 'vitest';
import request from 'supertest';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { portableDatabase, poolAdapters, fixture } from '../helpers/database.js';
import { fixtureBearer, withProviderSessions } from '../helpers/provider-sessions.js';
import { createApp } from '../../apps/api/src/app.js';
import type { Config } from '../../apps/api/src/lib/config.js';

let db: PGlite, f: Awaited<ReturnType<typeof fixture>>, app: ReturnType<typeof createApp>;
let firstExam: string, secondExam: string, privateExam: string, privateChild: string;
const call = (method: 'get' | 'post' | 'patch', path: string, role = 'admin') =>
  request(app)
    [method]('/api/v1' + path)
    .set('Authorization', 'Bearer ' + fixtureBearer(role))
    .set('X-School-Id', f.schoolA);
async function create(path: string, body: Record<string, unknown>) {
  const r = await call('post', '/resources/' + path).send(body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}
beforeAll(async () => {
  db = await portableDatabase();
  f = await fixture(db);
  const identities: Record<string, string> = {
    admin: f.admin,
    principal: f.principal,
    teacher: f.teacher,
    parent: f.parent,
    student: f.studentUser,
  };
  const auth = {
    auth: {
      getUser: async (token: string) => ({
        data: { user: { id: identities[token] } },
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
});
afterAll(async () => db.close());

it('School Admin creates class tests and records marks while unpublished results remain absent from performance for every role', async () => {
  const otherTeacher = await create('teachers', {
    staff_code: 'PERFORMANCE_OTHER',
    full_name: 'Other class teacher',
  });
  const otherClass = await create('classes', {
    academic_session_id: f.session,
    grade: '8',
    section: 'B',
    class_teacher_id: otherTeacher,
  });
  await create('teacher_class_assignments', {
    class_id: otherClass,
    subject_id: f.subject,
    teacher_id: otherTeacher,
    starts_on: '2026-01-01',
  });
  const classmate = await create('students', {
    student_code: 'PERFORMANCE_CLASSMATE',
    first_name: 'Classmate',
  });
  privateChild = await create('students', {
    student_code: 'PERFORMANCE_PRIVATE',
    first_name: 'Private class learner',
  });
  for (const [sid, cid] of [
    [classmate, f.classId],
    [privateChild, otherClass],
  ])
    await create('enrollments', {
      student_id: sid,
      class_id: cid,
      academic_session_id: f.session,
      starts_on: '2026-01-01',
    });
  async function exam(name: string, cid: string, maximum: number) {
    return create('exams', {
      class_id: cid,
      subject_id: f.subject,
      name,
      assessment_kind: 'SUBJECT_TEST',
      exam_type: 'UNIT',
      max_score: maximum,
      status: 'OPEN',
    });
  }
  firstExam = await exam('Math test 1', f.classId, 100);
  secondExam = await exam('Math test 2', f.classId, 50);
  privateExam = await exam('Other section test', otherClass, 100);
  for (const [eid, sid, score] of [
    [firstExam, f.student, 80],
    [firstExam, classmate, 40],
    [secondExam, f.student, 45],
    [privateExam, privateChild, 20],
  ] as const)
    await create('marks', { exam_id: eid, student_id: sid, subject_id: f.subject, score });
  for (const role of ['admin', 'principal', 'teacher', 'parent', 'student']) {
    const r = await call('get', '/analytics', role);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.academics).toEqual([]);
  }
});
it('publishing exposes school totals to Admin/Principal, assigned-class totals to Teacher and only own/linked-child scores to Student/Parent', async () => {
  for (const eid of [firstExam, privateExam])
    expect(
      (await call('patch', '/resources/exams/' + eid).send({ status: 'PUBLISHED' })).status,
    ).toBe(200);
  for (const role of ['admin', 'principal']) {
    const r = await call('get', '/analytics', role);
    expect(r.body.academics).toHaveLength(2);
    expect(r.body.academics.find((x: any) => x.section === 'A')).toMatchObject({
      students: 2,
      assessments: 2,
      percentage: '60.00',
    });
    expect(r.body.academics.find((x: any) => x.section === 'B')).toMatchObject({
      students: 1,
      assessments: 1,
      percentage: '20.00',
    });
  }
  for (const role of ['teacher', 'parent', 'student']) {
    const r = await call('get', '/analytics', role);
    expect(r.body.academics).toHaveLength(1);
    expect(r.body.academics[0]).toMatchObject({
      section: 'A',
      students: role === 'teacher' ? 2 : 1,
      percentage: role === 'teacher' ? '60.00' : '80.00',
    });
    expect((await call('get', '/analytics?student_id=' + privateChild, role)).status).toBe(404);
  }
  for (const role of ['parent', 'student']) {
    const marks = await call('get', '/resources/marks', role);
    expect(marks.body.data).toHaveLength(1);
    expect(marks.body.data[0].score).toBe('80.00');
  }
});
it('uses actual maxima after a second publication and excludes missing mark entries rather than treating them as zero', async () => {
  expect(
    (await call('patch', '/resources/exams/' + secondExam).send({ status: 'PUBLISHED' })).status,
  ).toBe(200);
  for (const role of ['admin', 'principal', 'teacher', 'parent', 'student']) {
    const r = await call('get', '/analytics', role),
      row = r.body.academics.find((x: any) => x.section === 'A');
    expect(row).toMatchObject({
      assessments: ['parent', 'student'].includes(role) ? 2 : 3,
      percentage: ['parent', 'student'].includes(role) ? '83.33' : '66.00',
    });
  }
  expect(
    (
      await call(
        'patch',
        '/resources/marks/' +
          (await call('get', '/resources/marks?exam_id=' + firstExam)).body.data[0].id,
      ).send({ score: 90 })
    ).status,
  ).toBe(409);
});
