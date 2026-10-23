import { fixtureBearer, withProviderSessions } from '../helpers/provider-sessions.js';
import { beforeAll, afterAll, it, expect } from 'vitest';
import request from 'supertest';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { portableDatabase, poolAdapters, fixture } from '../helpers/database.js';
import { createApp } from '../../apps/api/src/app.js';
import type { Config } from '../../apps/api/src/lib/config.js';

let db: PGlite, f: Awaited<ReturnType<typeof fixture>>, app: ReturnType<typeof createApp>;
let section: string, child: string, english: string, examA: string, examB: string, markA: string;
const call = (method: 'get' | 'post' | 'patch', path: string, role = 'admin') =>
  request(app)
    [method]('/api/v1' + path)
    .set('Authorization', 'Bearer ' + fixtureBearer(role))
    .set('X-School-Id', f.schoolA);
beforeAll(async () => {
  db = await portableDatabase();
  f = await fixture(db);
  const supabase = {
    auth: {
      getUser: async (token: string) => ({
        data: {
          user: {
            id: (
              {
                admin: f.admin,
                teacher: f.teacher,
                principal: f.principal,
                parent: f.parent,
                student: f.studentUser,
              } as Record<string, string>
            )[token],
          },
        },
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
  section = (
    await call('post', '/resources/classes').send({
      academic_session_id: f.session,
      grade: '8',
      section: 'B',
      class_teacher_id: f.teacherId,
    })
  ).body.id;
  english = (
    await call('post', '/resources/subjects').send({ code: 'RESULT_ENG', name: 'English results' })
  ).body.id;
  await call('post', '/resources/teacher_class_assignments').send({
    teacher_id: f.teacherId,
    class_id: section,
    subject_id: english,
    starts_on: '2026-01-01',
  });
  child = (
    await call('post', '/resources/students').send({
      student_code: 'RESULT_B',
      first_name: 'Section B learner',
    })
  ).body.id;
  await call('post', '/resources/enrollments').send({
    student_id: child,
    class_id: section,
    academic_session_id: f.session,
    starts_on: '2026-01-01',
  });
  for (const [cid, subject, name] of [
    [f.classId, f.subject, 'Class A mathematics'],
    [section, english, 'Class B English'],
  ]) {
    const r = await call('post', '/resources/exams').send({
      class_id: cid,
      subject_id: subject,
      assessment_kind: 'SUBJECT_TEST',
      name,
      exam_type: 'UNIT',
      max_score: 50,
      status: 'OPEN',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    if (cid === f.classId) examA = r.body.id;
    else examB = r.body.id;
  }
  const r = await call('post', '/resources/marks').send({
    exam_id: examA,
    student_id: f.student,
    subject_id: f.subject,
    score: 40,
  });
  expect(r.status).toBe(201);
  markA = r.body.id;
  expect(
    (
      await call('post', '/resources/marks').send({
        exam_id: examB,
        student_id: child,
        subject_id: english,
        score: 45,
      })
    ).status,
  ).toBe(201);
});
afterAll(async () => db.close());
it('filters exams, configured subjects, enrolled students and saved marks by the exact class and section', async () => {
  const exams = await call('get', '/resources/exams?class_id=' + f.classId);
  expect(exams.body.data.map((x: any) => x.id)).toEqual([examA]);
  const subjects = await call('get', '/resources/subjects?class_id=' + f.classId);
  expect(subjects.body.data.map((x: any) => x.id)).toEqual([f.subject]);
  const students = await call('get', '/resources/students?class_id=' + section);
  expect(students.body.data.map((x: any) => x.id)).toEqual([child]);
  expect(
    (await call('get', '/resources/marks?class_id=' + f.classId)).body.data.map((x: any) => x.id),
  ).toEqual([markA]);
  expect(
    (await call('get', `/resources/marks?class_id=${f.classId}&exam_id=${examB}`)).body.total,
  ).toBe(0);
  expect(
    (await call('get', `/resources/marks?class_id=${section}&exam_id=${examB}`)).body.total,
  ).toBe(1);
});
it('rejects cross-class students and wrong test subjects on individual create and update', async () => {
  expect(
    (
      await call('post', '/resources/marks').send({
        exam_id: examA,
        student_id: child,
        subject_id: f.subject,
        score: 20,
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await call('post', '/resources/marks').send({
        exam_id: examA,
        student_id: f.student,
        subject_id: english,
        score: 20,
      })
    ).status,
  ).toBe(422);
  expect(
    (await call('patch', '/resources/marks/' + markA).send({ student_id: child })).status,
  ).toBe(422);
  expect((await call('patch', '/resources/marks/' + markA).send({ score: 42 })).status).toBe(200);
  expect((await call('get', '/resources/marks/' + markA)).body.student_id).toBe(f.student);
});
it('validates every CSV row against its exam class and subject without partially saving', async () => {
  const before = (await call('get', '/resources/marks?exam_id=' + examA)).body.data;
  const result = await call('post', '/marks/bulk')
    .set('Idempotency-Key', crypto.randomUUID())
    .send({
      exam_id: examA,
      entries: [
        { student_id: f.student, subject_id: f.subject, score: 10 },
        { student_id: child, subject_id: f.subject, score: 30 },
      ],
    });
  expect(result.status).toBe(422);
  expect((await call('get', '/resources/marks?exam_id=' + examA)).body.data).toEqual(before);
  expect(
    (
      await call('post', '/marks/bulk')
        .set('Idempotency-Key', crypto.randomUUID())
        .send({
          exam_id: examA,
          entries: [{ student_id: f.student, subject_id: english, score: 30 }],
        })
    ).status,
  ).toBe(422);
});
it('preserves role and school boundaries and refuses changes to locked examinations', async () => {
  for (const role of ['principal', 'parent', 'student'])
    expect(
      (
        await call('post', '/resources/marks', role).send({
          exam_id: examA,
          student_id: f.student,
          subject_id: f.subject,
          score: 25,
        })
      ).status,
    ).toBe(403);
  for (const path of ['marks', 'subjects'])
    expect((await call('get', `/resources/${path}?class_id=${crypto.randomUUID()}`)).status).toBe(
      404,
    );
  expect(
    (
      await call('post', '/resources/marks').send({
        exam_id: examA,
        student_id: f.foreignStudent,
        subject_id: f.subject,
        score: 20,
      })
    ).status,
  ).toBe(404);
  expect((await call('patch', '/resources/exams/' + examA).send({ status: 'LOCKED' })).status).toBe(
    200,
  );
  expect((await call('patch', '/resources/marks/' + markA).send({ score: 43 })).status).toBe(409);
  expect(
    (
      await call('post', '/marks/bulk')
        .set('Idempotency-Key', crypto.randomUUID())
        .send({
          exam_id: examA,
          entries: [{ student_id: f.student, subject_id: f.subject, score: 30 }],
        })
    ).status,
  ).toBe(409);
});
