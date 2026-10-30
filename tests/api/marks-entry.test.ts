import { fixtureBearer, withProviderSessions } from '../helpers/provider-sessions.js';
import { beforeAll, afterAll, it, expect } from 'vitest';
import request from 'supertest';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { portableDatabase, poolAdapters, fixture } from '../helpers/database.js';
import { createApp } from '../../apps/api/src/app.js';
import type { Config } from '../../apps/api/src/lib/config.js';
let db: PGlite,
  f: Awaited<ReturnType<typeof fixture>>,
  app: ReturnType<typeof createApp>,
  productionApp: ReturnType<typeof createApp>,
  exam: string,
  official: string,
  otherExam: string,
  english: string,
  ct: string;
const call = (path: string, role = 'admin', school?: string) =>
  request(app)
    .get('/api/v1' + path)
    .set('Authorization', 'Bearer ' + fixtureBearer(role))
    .set('X-School-Id', school || f.schoolA);
beforeAll(async () => {
  db = await portableDatabase();
  f = await fixture(db);
  ct = crypto.randomUUID();
  const teacherId = crypto.randomUUID();
  await db.query("INSERT INTO auth.users(id,email) VALUES($1,'class-teacher@example.test')", [ct]);
  await db.query("UPDATE users SET full_name='Class Teacher' WHERE id=$1", [ct]);
  await db.query(
    "INSERT INTO school_memberships(school_id,user_id,role_id,status) SELECT $1,$2,id,'ACTIVE' FROM roles WHERE code='teacher'",
    [f.schoolA, ct],
  );
  await db.query(
    "INSERT INTO teachers(id,school_id,user_id,staff_code,full_name) VALUES($1,$2,$3,'ENTRY_CT','Entry class teacher')",
    [teacherId, f.schoolA, ct],
  );
  await db.query('UPDATE classes SET class_teacher_id=$1 WHERE id=$2', [teacherId, f.classId]);
  english = crypto.randomUUID();
  await db.query(
    "INSERT INTO subjects(id,school_id,code,name) VALUES($1,$2,'ENTRY_ENG','English')",
    [english, f.schoolA],
  );
  await db.query(
    "INSERT INTO teacher_class_assignments(school_id,teacher_id,class_id,subject_id,starts_on) VALUES($1,$2,$3,$4,'2026-01-01')",
    [f.schoolA, f.teacherId, f.classId, english],
  );
  await db.query("UPDATE enrollments SET roll_number='10' WHERE student_id=$1", [f.student]);
  for (const roll of ['2', '1']) {
    const sid = crypto.randomUUID();
    await db.query(
      "INSERT INTO students(id,school_id,student_code,first_name) VALUES($1,$2,$3,'Entry learner')",
      [sid, f.schoolA, 'ENTRY_' + roll],
    );
    await db.query(
      "INSERT INTO enrollments(school_id,student_id,class_id,academic_session_id,roll_number,starts_on) VALUES($1,$2,$3,$4,$5,'2026-01-01')",
      [f.schoolA, sid, f.classId, f.session, roll],
    );
  }
  exam = crypto.randomUUID();
  official = crypto.randomUUID();
  otherExam = crypto.randomUUID();
  const foreignSession = crypto.randomUUID(),
    foreignClass = crypto.randomUUID();
  await db.query(
    "INSERT INTO academic_sessions(id,school_id,name,starts_on,ends_on) VALUES($1,$2,'Foreign session','2026-01-01','2026-12-31')",
    [foreignSession, f.schoolB],
  );
  await db.query(
    "INSERT INTO classes(id,school_id,academic_session_id,grade,section) VALUES($1,$2,$3,'2','OTHER')",
    [foreignClass, f.schoolB, foreignSession],
  );
  await db.query(
    "INSERT INTO exams(id,school_id,class_id,name,assessment_kind,subject_id,exam_type,max_score,status) VALUES($1,$2,$3,'Entry test','SUBJECT_TEST',$4,'UNIT',50,'OPEN'),($5,$2,$3,'Official entry','OFFICIAL',NULL,'FINAL',100,'OPEN')",
    [exam, f.schoolA, f.classId, f.subject, official],
  );
  await db.query(
    "INSERT INTO exams(id,school_id,class_id,name,exam_type,max_score,status) VALUES($1,$2,$3,'Other school','UNIT',50,'OPEN')",
    [otherExam, f.schoolB, foreignClass],
  );
  await db.query(
    'INSERT INTO marks(school_id,exam_id,student_id,subject_id,score,entered_by) VALUES($1,$2,$3,$4,0,$5)',
    [f.schoolA, exam, f.student, f.subject, f.admin],
  );
  const supabase = {
    auth: {
      getUser: async (token: string) => ({
        data: {
          user: {
            id: (
              {
                admin: f.admin,
                teacher: f.teacher,
                ct,
                parent: f.parent,
                student: f.studentUser,
                principal: f.principal,
              } as Record<string, string>
            )[token],
          },
        },
        error: null,
      }),
    },
  } as unknown as SupabaseClient;
  const provider = withProviderSessions(db, supabase);
  app = createApp(
    {
      NODE_ENV: 'test',
      WEB_ORIGINS: 'http://localhost:5173',
      TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32),
      TRUST_PROXY_HOPS: 0,
    } as Config,
    { ...poolAdapters(db), supabase: provider },
  );
  productionApp = createApp(
    {
      NODE_ENV: 'production',
      WEB_ORIGINS: 'http://localhost:5173',
      TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32),
      TRUST_PROXY_HOPS: 0,
    } as Config,
    { ...poolAdapters(db), supabase: provider },
  );
});
afterAll(async () => db.close());
it('returns the exact class roster in numeric roll order, one test subject and existing zero marks', async () => {
  const r = await call('/marks/entry-sheet?exam_id=' + exam);
  expect(r.status).toBe(200);
  expect(r.body.students.map((s: any) => s.roll_number)).toEqual(['1', '2', '10']);
  expect(r.body.subjects.map((s: any) => s.id)).toEqual([f.subject]);
  expect(r.body.marks[0].score).toBe(0);
  expect(r.body.students.some((s: any) => s.id === f.foreignStudent)).toBe(false);
  expect(r.body.students[0]).not.toHaveProperty('user_id');
});
it('allows subject test teachers and permits all configured official subjects only to the Class Teacher/admin', async () => {
  expect((await call('/marks/entry-sheet?exam_id=' + exam, 'teacher')).status).toBe(200);
  const r = await call('/marks/entry-sheet?exam_id=' + official, 'ct');
  expect(r.status).toBe(200);
  expect(r.body.subjects.map((s: any) => s.id).sort()).toEqual([f.subject, english].sort());
  expect([403, 404]).toContain(
    (await call('/marks/entry-sheet?exam_id=' + official, 'teacher')).status,
  );
});
it('single-student entry saves safely, rejects multi-row bypass and replays the same score once', async () => {
  const body = {
      exam_id: exam,
      entries: [{ student_id: f.student, subject_id: f.subject, score: 25 }],
    },
    key = crypto.randomUUID();
  const post = (payload: unknown, idempotency = crypto.randomUUID()) =>
    request(app)
      .post('/api/v1/marks/entry')
      .set('Authorization', 'Bearer ' + fixtureBearer('teacher'))
      .set('X-School-Id', f.schoolA)
      .set('Idempotency-Key', idempotency)
      .send(payload);
  for (let i = 0; i < 6; i++)
    expect((await post({ ...body, entries: [{ ...body.entries[0], score: i }] })).status).toBe(200);
  expect((await post(body, key)).status).toBe(200);
  expect((await post(body, key)).status).toBe(200);
  expect((await post({ ...body, entries: [body.entries[0], body.entries[0]] })).status).toBe(422);
  expect(
    (await post({ ...body, entries: [{ ...body.entries[0], student_id: f.foreignStudent }] }))
      .status,
  ).toBe(422);
  expect((await post({ ...body, exam_id: official })).status).toBe(404);
  expect((await post({ ...body, entries: [{ ...body.entries[0], score: 26 }] }, key)).status).toBe(
    409,
  );
});
it('production limits permit rapid single-student entry while retaining the five-per-minute bulk limit', async () => {
  const body = {
    exam_id: exam,
    entries: [{ student_id: f.student, subject_id: f.subject, score: 22 }],
  };
  const post = (path: string) =>
    request(productionApp)
      .post('/api/v1/marks/' + path)
      .set('Authorization', 'Bearer ' + fixtureBearer('teacher'))
      .set('X-School-Id', f.schoolA)
      .set('Idempotency-Key', crypto.randomUUID())
      .send(body);
  for (let i = 0; i < 6; i++) expect((await post('entry')).status).toBe(200);
  for (let i = 0; i < 5; i++) expect((await post('bulk')).status).toBe(200);
  const limited = await post('bulk');
  expect(limited.status).toBe(429);
  expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  expect((await post('entry')).status).toBe(200);
});
it('denies parents/students/principals, foreign schools, invalid IDs and archived or locked exams', async () => {
  for (const role of ['parent', 'student', 'principal'])
    expect((await call('/marks/entry-sheet?exam_id=' + exam, role)).status).toBe(403);
  expect((await call('/marks/entry-sheet?exam_id=' + otherExam)).status).toBe(404);
  expect((await call('/marks/entry-sheet?exam_id=invalid')).status).toBe(422);
  await db.query("UPDATE exams SET status='LOCKED' WHERE id=$1", [exam]);
  expect((await call('/marks/entry-sheet?exam_id=' + exam)).status).toBe(409);
  const result = await request(app)
    .post('/api/v1/marks/bulk')
    .set('Authorization', 'Bearer ' + fixtureBearer('admin'))
    .set('X-School-Id', f.schoolA)
    .send({
      exam_id: exam,
      entries: [{ student_id: f.student, subject_id: f.subject, score: 20 }],
    });
  expect(result.status).toBe(409);
});
