import { afterAll, beforeAll, expect, it } from 'vitest';
import request from 'supertest';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fixture, poolAdapters, portableDatabase } from '../helpers/database.js';
import { fixtureBearer, withProviderSessions } from '../helpers/provider-sessions.js';
import { createApp } from '../../apps/api/src/app.js';
import type { Config } from '../../apps/api/src/lib/config.js';

let db: PGlite, f: Awaited<ReturnType<typeof fixture>>, app: ReturnType<typeof createApp>;
let exam: string, secondExam: string, secondClass: string, cohort: string, olderExam: string;
let tied: string, absent: string, partial: string, zero: string, schoolWinner: string;
const call = (method: 'get' | 'post' | 'patch' | 'put', path: string, role = 'admin') =>
  request(app)
    [method]('/api/v1' + path)
    .set('Authorization', 'Bearer ' + fixtureBearer(role))
    .set('X-School-Id', f.schoolA);
const create = async (resource: string, data: object) => {
  const response = await call('post', '/resources/' + resource).send(data);
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.id as string;
};
const details = (examId: string, studentId: string, role = 'principal') =>
  call('get', `/results/exams/${examId}/students/${studentId}`, role);
const analytics = (query = '', role = 'principal') =>
  call('get', `/results/analytics?session_id=${f.session}&cohort_id=${cohort}${query}`, role);

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

  secondClass = await create('classes', {
    academic_session_id: f.session,
    grade: '8',
    section: 'B',
    class_teacher_id: f.teacherId,
  });
  const subject = async (code: string, name: string, classId: string) => {
    const id = await create('subjects', { code, name });
    await create('teacher_class_assignments', {
      teacher_id: f.teacherId,
      class_id: classId,
      subject_id: id,
      starts_on: '2026-01-01',
    });
    return id;
  };
  const english = await subject('ANALYTICS_ENG', 'English', f.classId);
  const science = await subject('ANALYTICS_SCI', 'Science', secondClass);
  const student = async (code: string, classId = f.classId) => {
    const id = await create('students', { student_code: code, first_name: code });
    await create('enrollments', {
      student_id: id,
      class_id: classId,
      academic_session_id: f.session,
      starts_on: '2026-01-01',
    });
    return id;
  };
  tied = await student('TIE');
  absent = await student('UNRECORDED');
  partial = await student('PARTIAL');
  zero = await student('ZERO');
  schoolWinner = await student('WINNER', secondClass);
  const examination = (classId: string, name: string, max: number, date: string) =>
    create('exams', {
      class_id: classId,
      name,
      exam_type: 'UNIT',
      max_score: max,
      starts_on: date,
      status: 'OPEN',
    });
  exam = await examination(f.classId, 'Comparison test', 100, '2026-09-01');
  secondExam = await examination(secondClass, 'comparison test', 50, '2026-09-02');
  olderExam = await examination(f.classId, 'Earlier examination', 100, '2026-06-01');
  for (const [exam_id, student_id, subject_id, score] of [
    [exam, f.student, f.subject, 90],
    [exam, f.student, english, 70],
    [exam, tied, f.subject, 80],
    [exam, tied, english, 80],
    [exam, zero, f.subject, 0],
    [exam, zero, english, 0],
    [exam, partial, f.subject, 95],
    [secondExam, schoolWinner, science, 45],
    [olderExam, f.student, f.subject, 50],
  ])
    await create('marks', { exam_id, student_id, subject_id, score });
  for (const id of [exam, secondExam, olderExam])
    expect(
      (await call('patch', '/resources/exams/' + id).send({ status: 'PUBLISHED' })).status,
    ).toBe(200);

  const catalogue = await call('get', '/results/examinations?session_id=' + f.session, 'principal');
  expect(catalogue.status, JSON.stringify(catalogue.body)).toBe(200);
  cohort = catalogue.body.data.find((item: { id: string }) => item.id === exam).cohort_id;
  expect(catalogue.body.data.find((item: { id: string }) => item.id === secondExam).cohort_id).toBe(
    cohort,
  );
  expect(
    catalogue.body.data.find((item: { id: string }) => item.id === olderExam).cohort_id,
  ).not.toBe(cohort);
}, 120_000);

afterAll(async () => db.close());

it('computes recorded maxima, missing subject status, zero scores and shared ranks', async () => {
  const first = await details(exam, f.student);
  expect(first.status, JSON.stringify(first.body)).toBe(200);
  expect(first.body).toMatchObject({
    student: {
      percentage: 80,
      obtained: 160,
      maximum: 200,
      class_position: { rank: 1, tied: true },
      school_position: { rank: 2, tied: true },
    },
    grade: null,
    status: 'RECORDED',
    recorded_maximum: 200,
  });
  expect(first.body.subjects).toHaveLength(2);
  expect((await details(exam, tied)).body.student.class_position).toEqual({ rank: 1, tied: true });
  expect((await details(exam, zero)).body.student).toMatchObject({
    obtained: 0,
    percentage: 0,
    class_position: { rank: 3, tied: false },
  });
  expect((await details(exam, partial)).body).toMatchObject({
    status: 'INCOMPLETE',
    recorded_maximum: 100,
    student: {
      obtained: 95,
      maximum: 200,
      percentage: 95,
      class_position: null,
      school_position: null,
    },
    subjects: expect.arrayContaining([expect.objectContaining({ name: 'English', score: null })]),
  });
  expect((await details(exam, absent)).body).toMatchObject({
    status: 'NO_MARKS',
    student: { obtained: null, percentage: null, class_position: null },
  });
  expect((await details(secondExam, schoolWinner)).body.student).toMatchObject({
    percentage: 90,
    school_position: { rank: 1, tied: false },
  });
});

it('updates class, subject, distribution and trend data for the filtered scope', async () => {
  const result = await analytics();
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  const { classes, school_toppers, distribution, exam_comparison, session_trend, subjects } =
    result.body;
  expect(classes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        class_id: f.classId,
        total: 5,
        appeared: 4,
        incomplete: 1,
        passed: null,
        failed: null,
        average_marks: 103.75,
        average_percentage: 63.75,
        lowest_marks: 0,
        highest_marks: 160,
      }),
      expect.objectContaining({
        class_id: secondClass,
        total: 1,
        appeared: 1,
        average_percentage: 90,
      }),
    ]),
  );
  expect(school_toppers.map((row: { student_id: string }) => row.student_id)).toEqual([
    schoolWinner,
    f.student,
    tied,
  ]);
  expect(distribution.map((point: { count: number }) => point.count)).toEqual([1, 0, 0, 0, 4]);
  expect(exam_comparison).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: olderExam, percentage: 50 }),
      expect.objectContaining({ id: cohort, percentage: 69 }),
    ]),
  );
  expect(session_trend).toEqual([expect.objectContaining({ id: f.session, count: 6 })]);
  expect(subjects[0]).toMatchObject({ name: 'Science', percentage: 90 });
  const scoped = await analytics('&grade=8&class_id=' + secondClass);
  expect(scoped.status).toBe(200);
  expect(scoped.body.classes.map((row: { class_id: string }) => row.class_id)).toEqual([
    secondClass,
  ]);
  expect(scoped.body.subjects).toEqual([expect.objectContaining({ name: 'Science' })]);
  expect(scoped.body.exam_comparison).toEqual([
    expect.objectContaining({ id: cohort, percentage: 90 }),
  ]);
});

it('allows only leadership in the active school and rejects off-roster students', async () => {
  for (const role of ['teacher', 'parent', 'studentUser']) {
    expect((await analytics('', role)).status).toBe(403);
    expect((await details(exam, f.student, role)).status).toBe(403);
    expect((await call('get', '/results/exams/' + exam + '/students', role)).status).toBe(403);
  }
  expect((await analytics().set('X-School-Id', f.schoolB)).status).toBe(404);
  expect((await details(exam, f.foreignStudent)).status).toBe(404);
  expect((await details(exam, schoolWinner)).status).toBe(404);
  expect((await analytics('&class_id=' + crypto.randomUUID())).status).toBe(404);
  const roster = await call('get', '/results/exams/' + exam + '/students?search=TIE', 'principal');
  expect(roster.status, JSON.stringify(roster.body)).toBe(200);
  expect(roster.body.data).toEqual([expect.objectContaining({ id: tied })]);
});

it('uses an approved grading policy for complete results and rejects unauthorized changes', async () => {
  const policy = {
    pass_percentage: 40,
    grades: [
      { label: 'A', minimum: 75 },
      { label: 'C', minimum: 0 },
    ],
  };
  expect((await call('put', '/results/policy', 'principal').send(policy)).status).toBe(403);
  expect(
    (
      await call('put', '/results/policy').send({
        ...policy,
        grades: [{ label: 'A', minimum: 75 }],
      })
    ).status,
  ).toBe(422);
  const saved = await call('put', '/results/policy').send(policy);
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  expect((await details(exam, f.student)).body).toMatchObject({ grade: 'A', status: 'PASSED' });
  expect((await details(exam, zero)).body).toMatchObject({ grade: 'C', status: 'FAILED' });
  expect((await details(exam, partial)).body).toMatchObject({ grade: null, status: 'INCOMPLETE' });
  expect((await analytics()).body.classes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ class_id: f.classId, passed: 2, failed: 1 }),
    ]),
  );
});
