import { fixtureBearer, withProviderSessions } from '../helpers/provider-sessions.js';
import { beforeAll, afterAll, it, expect } from 'vitest';
import request from 'supertest';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { portableDatabase, poolAdapters, fixture } from '../helpers/database.js';
import { createApp } from '../../apps/api/src/app.js';
import type { Config } from '../../apps/api/src/lib/config.js';

let db: PGlite, f: Awaited<ReturnType<typeof fixture>>, app: ReturnType<typeof createApp>;
function token(role = 'principal', aal = 'aal2') {
  return 'fixture.' + Buffer.from(JSON.stringify({ role, aal })).toString('base64url') + '.fixture';
}
beforeAll(async () => {
  db = await portableDatabase();
  f = await fixture(db);
  const auth = {
    auth: {
      getUser: async (value: string) => {
        const role = JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString()).role;
        const id = { principal: f.principal, parent: f.parent, admin: f.admin }[
          role as 'principal'
        ];
        return {
          data: { user: id ? { id, factors: [] } : null },
          error: id ? null : { message: 'invalid' },
        };
      },
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
const call = (path: string, role = 'principal', aal = 'aal2') =>
  request(app)
    .get('/api/v1' + path)
    .set('Authorization', 'Bearer ' + fixtureBearer(token(role, aal)))
    .set('X-School-Id', f.schoolA);

it('counts the entire actionable correction queue and excludes terminal and self-authored requests', async () => {
  const day = (
    await db.query<{ id: string }>(
      "INSERT INTO daily_attendance(school_id,student_id,class_id,academic_session_id,attendance_date,attendance_status,source) VALUES($1,$2,$3,$4,'2026-10-21','ABSENT','MANUAL') RETURNING id",
      [f.schoolA, f.student, f.classId, f.session],
    )
  ).rows[0].id;
  await db.query(
    "INSERT INTO attendance_corrections(school_id,daily_attendance_id,requested_status,reason,requested_by,requested_at) SELECT $1,$2,'PRESENT','Pending older review '||n,$3,now()-interval '1 day' FROM generate_series(1,12) n",
    [f.schoolA, day, f.teacher],
  );
  await db.query(
    "INSERT INTO attendance_corrections(school_id,daily_attendance_id,requested_status,reason,requested_by,status) SELECT $1,$2,'PRESENT','Already rejected '||n,$3,'REJECTED' FROM generate_series(1,10) n",
    [f.schoolA, day, f.teacher],
  );
  await db.query(
    "INSERT INTO attendance_corrections(school_id,daily_attendance_id,requested_status,reason,requested_by) VALUES($1,$2,'PRESENT','Own request is not actionable',$3)",
    [f.schoolA, day, f.principal],
  );
  const pending = await call('/corrections?status=REQUESTED&reviewable=1&page_size=1');
  expect(pending.status).toBe(200);
  expect(pending.body.total).toBe(12);
  expect(pending.body.data).toHaveLength(1);
  expect(pending.body.data[0]).toMatchObject({ status: 'REQUESTED', requested_by: f.teacher });
  expect((await call('/corrections?status=REQUESTED')).body.total).toBe(13);
  expect((await call('/corrections?status=REJECTED')).body.total).toBe(10);
  expect((await call('/corrections')).body.total).toBe(23);
});

it('validates correction filters and restricts the reviewer filter to approvers', async () => {
  expect((await call('/corrections?status=anything')).status).toBe(422);
  expect((await call('/corrections?reviewable=true')).status).toBe(422);
  expect((await call('/corrections?reviewable=1', 'parent')).status).toBe(403);
  const parent = await call('/corrections?status=REQUESTED', 'parent');
  expect(parent.status).toBe(200);
  expect(parent.body.data.every((r: any) => r.student_id === f.student)).toBe(true);
});

it('gives the Principal school-wide results even without an assigned teaching class', async () => {
  const second = (
    await db.query<{ id: string }>(
      "INSERT INTO classes(school_id,academic_session_id,grade,section) VALUES($1,$2,'9','B') RETURNING id",
      [f.schoolA, f.session],
    )
  ).rows[0].id;
  const learner = (
    await db.query<{ id: string }>(
      "INSERT INTO students(school_id,student_code,first_name) VALUES($1,'SECOND_CLASS','Second class learner') RETURNING id",
      [f.schoolA],
    )
  ).rows[0].id;
  await db.query(
    "INSERT INTO enrollments(school_id,student_id,class_id,academic_session_id,starts_on) VALUES($1,$2,$3,$4,'2026-01-01')",
    [f.schoolA, learner, second, f.session],
  );
  const exam = (
    await db.query<{ id: string }>(
      "INSERT INTO exams(school_id,class_id,name,exam_type,max_score,status) VALUES($1,$2,'Principal school-wide assessment','UNIT',100,'PUBLISHED') RETURNING id",
      [f.schoolA, second],
    )
  ).rows[0].id;
  await db.query(
    'INSERT INTO marks(school_id,exam_id,student_id,subject_id,score,entered_by) VALUES($1,$2,$3,$4,91,$5)',
    [f.schoolA, exam, learner, f.subject, f.admin],
  );
  const analytics = await call('/analytics');
  expect(analytics.status).toBe(200);
  expect(analytics.body.academics.find((r: any) => r.grade === '9')).toMatchObject({
    section: 'B',
    percentage: '91.00',
    students: 1,
  });
  expect((await call('/resources/students/' + learner)).status).toBe(200);
  expect((await call('/students/' + learner + '/overview')).status).toBe(200);
  expect((await call('/analytics?student_id=' + f.foreignStudent)).status).toBe(404);
});

it('enforces school-required Principal MFA before granting school data access', async () => {
  await db.query(
    "UPDATE schools SET settings=jsonb_set(settings,'{security}','{\"require_privileged_mfa\":true}'::jsonb) WHERE id=$1",
    [f.schoolA],
  );
  try {
    expect((await call('/me', 'principal', 'aal1')).body.security_mfa_required).toBe(true);
    const denied = await call('/resources/students', 'principal', 'aal1');
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('MFA_ENROLLMENT_REQUIRED');
    expect((await call('/resources/students')).status).toBe(200);
  } finally {
    await db.query("UPDATE schools SET settings=settings-'security' WHERE id=$1", [f.schoolA]);
  }
});

it('revokes Principal access immediately when membership is suspended', async () => {
  await db.query(
    "UPDATE school_memberships SET status='SUSPENDED' WHERE school_id=$1 AND user_id=$2",
    [f.schoolA, f.principal],
  );
  try {
    expect((await call('/resources/students')).status).toBe(404);
    expect((await call('/analytics')).status).toBe(404);
  } finally {
    await db.query(
      "UPDATE school_memberships SET status='ACTIVE' WHERE school_id=$1 AND user_id=$2",
      [f.schoolA, f.principal],
    );
  }
  expect((await call('/resources/students')).status).toBe(200);
});

it('keeps Principal reads available while a read-only subscription blocks announcement writes', async () => {
  await db.query("UPDATE subscriptions SET status='SUSPENDED_READONLY' WHERE school_id=$1", [
    f.schoolA,
  ]);
  try {
    expect((await call('/resources/students')).status).toBe(200);
    const result = await request(app)
      .post('/api/v1/resources/announcements')
      .set('Authorization', 'Bearer ' + fixtureBearer(token()))
      .set('X-School-Id', f.schoolA)
      .send({
        title: 'Cancelled plan must not publish',
        body: 'Generated fixture only',
        audience: 'SCHOOL',
      });
    expect(result.status).toBe(403);
    expect(result.body.error.code).toBe('SUBSCRIPTION_READONLY');
  } finally {
    await db.query("UPDATE subscriptions SET status='ACTIVE' WHERE school_id=$1", [f.schoolA]);
  }
});
