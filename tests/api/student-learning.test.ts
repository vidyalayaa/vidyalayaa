import { beforeAll, afterAll, it, expect } from 'vitest';
import request from 'supertest';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fixture, portableDatabase, poolAdapters } from '../helpers/database.js';
import { fixtureBearer, withProviderSessions } from '../helpers/provider-sessions.js';
import { studentLearningScenario } from '../helpers/student-learning.js';
import { createApp } from '../../apps/api/src/app.js';
import { transaction } from '../../apps/api/src/lib/db.js';
import type { Config } from '../../apps/api/src/lib/config.js';
let db: PGlite,
  f: Awaited<ReturnType<typeof fixture>>,
  s: Awaited<ReturnType<typeof studentLearningScenario>>,
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
  s = await studentLearningScenario(db, f);
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
afterAll(async () => db.close());
it('combines only current own classes, session, class teacher and exact class subjects', async () => {
  const r = await call('/student/academics');
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.headers['cache-control']).toBe('no-store');
  expect(r.body.classes).toHaveLength(1);
  expect(r.body.classes[0]).toMatchObject({
    class_id: f.classId,
    grade: '8',
    section: 'A',
    session_name: 'Test year',
    class_teacher: 'Teacher Test',
  });
  expect(r.body.classes[0].subjects).toEqual([
    { id: f.subject, name: 'Mathematics', code: 'MAT', teachers: ['Teacher Test'] },
  ]);
  expect(JSON.stringify(r.body)).not.toMatch(/PRIVATE|Earlier subject|Other learner|user_id/);
});
it('returns only own published marks including zero and earlier enrollments, with useful labels and totals', async () => {
  const r = await call('/student/results');
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body.total).toBe(2);
  expect(r.body.summary).toMatchObject({
    score: 65,
    maximum: 200,
    percentage: 32.5,
    examinations: 2,
  });
  expect(r.body.data.find((row: any) => row.score === 0)).toMatchObject({
    examination: 'Zero score assessment',
    subject: 'Mathematics',
    grade: '8',
    section: 'A',
  });
  expect(r.body.data.find((row: any) => row.score === 65)).toMatchObject({
    examination: 'Earlier published assessment',
    subject: 'Earlier subject',
    grade: '7',
    session_name: 'Earlier learning year',
  });
  expect(JSON.stringify(r.body)).not.toMatch(
    /Private assessment|Locked assessment|Current assessment|student_id|user_id/,
  );
});
it('filters and paginates own results without leaking unauthorized exam or subject metadata', async () => {
  const r = await call(
    '/student/results?exam_id=' + s.ids['Zero score assessment'] + '&page_size=1',
  );
  expect(r.body.total).toBe(1);
  expect(r.body.data).toHaveLength(1);
  expect(r.body.summary.percentage).toBe(0);
  const page = await call('/student/results?page_size=1&page=2');
  expect(page.body.total).toBe(2);
  expect(page.body.data).toHaveLength(1);
  for (const q of ['exam_id=' + s.ids['Private assessment'], 'subject_id=' + s.privateSubject]) {
    const denied = await call('/student/results?' + q);
    expect(denied.status).toBe(200);
    expect(denied.body.total).toBe(0);
    expect(JSON.stringify(denied.body)).not.toContain('Private');
  }
});
it('makes entered marks visible only after publication while preserving administrator access', async () => {
  const exam = s.ids['Current assessment'];
  expect((await call('/student/results?exam_id=' + exam)).body.total).toBe(0);
  expect((await call('/resources/marks?exam_id=' + exam, 'admin')).body.total).toBe(2);
  const published = await request(app)
    .patch('/api/v1/resources/exams/' + exam)
    .set('Authorization', 'Bearer ' + fixtureBearer('admin'))
    .set('X-School-Id', f.schoolA)
    .send({ status: 'PUBLISHED' });
  expect(published.status, JSON.stringify(published.body)).toBe(200);
  const r = await call('/student/results?exam_id=' + exam);
  expect(r.body.total).toBe(1);
  expect(r.body.data[0].score).toBe(91);
});
it('rejects identity overrides, other roles, other schools and all student writes', async () => {
  for (const path of ['/student/academics', '/student/results']) {
    for (const key of ['student_id', 'user_id', 'class_id'])
      expect((await call(path + '?' + key + '=' + s.otherStudent)).status).toBe(422);
    for (const role of ['admin', 'parent', 'teacher', 'principal'])
      expect((await call(path, role)).status).toBe(403);
    expect((await request(app).get('/api/v1' + path)).status).toBe(401);
    expect((await call(path).set('X-School-Id', f.schoolB)).status).toBe(404);
    for (const method of ['post', 'patch', 'delete'] as const)
      expect(
        (
          await request(app)
            [method]('/api/v1' + path)
            .set('Authorization', 'Bearer ' + fixtureBearer('student'))
            .set('X-School-Id', f.schoolA)
            .send({ score: 100 })
        ).status,
      ).toBe(405);
  }
});
it('RLS independently hides other student and unpublished marks and refuses student writes', async () => {
  const ctx = { schoolId: f.schoolA, userId: f.studentUser };
  const rows = await transaction(
    pools.api,
    ctx,
    async (tx) => (await tx.query('SELECT student_id,exam_id FROM marks')).rows,
    true,
  );
  expect(rows).toHaveLength(3);
  expect(rows.every((row) => row.student_id === f.student)).toBe(true);
  expect(rows.map((row) => row.exam_id)).not.toContain(s.ids['Locked assessment']);
  const changed = await transaction(pools.api, ctx, async (tx) =>
    tx.query('UPDATE marks SET score=100 RETURNING id'),
  );
  expect(changed.rowCount).toBe(0);
  await expect(
    transaction(pools.api, ctx, async (tx) =>
      tx.query(
        'INSERT INTO marks(school_id,exam_id,student_id,subject_id,score) VALUES($1,$2,$3,$4,50)',
        [f.schoolA, s.ids['Current assessment'], f.student, f.subject],
      ),
    ),
  ).rejects.toMatchObject({ code: '42501' });
});
