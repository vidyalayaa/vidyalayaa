import { beforeAll, afterAll, it, expect } from 'vitest';
import request from 'supertest';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { portableDatabase, poolAdapters, fixture } from '../helpers/database.js';
import { fixtureBearer, withProviderSessions } from '../helpers/provider-sessions.js';
import { studentProfileScenario } from '../helpers/student-profile.js';
import { createApp } from '../../apps/api/src/app.js';
import { transaction } from '../../apps/api/src/lib/db.js';
import type { Config } from '../../apps/api/src/lib/config.js';
let db: PGlite,
  f: Awaited<ReturnType<typeof fixture>>,
  s: Awaited<ReturnType<typeof studentProfileScenario>>,
  pools: ReturnType<typeof poolAdapters>,
  app: ReturnType<typeof createApp>;
const call = (path = '/student/profile', role = 'student') =>
  request(app)
    .get('/api/v1' + path)
    .set('Authorization', 'Bearer ' + fixtureBearer(role))
    .set('X-School-Id', f.schoolA);
const ownTx = <T>(fn: Parameters<typeof transaction<T>>[2]) =>
  transaction(pools.api, { schoolId: f.schoolA, userId: f.studentUser }, fn);
beforeAll(async () => {
  db = await portableDatabase();
  f = await fixture(db);
  s = await studentProfileScenario(db, f);
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
        data: {
          user: identities[token]
            ? { id: identities[token], user_metadata: { student_id: s.other } }
            : null,
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
    { ...pools, supabase: withProviderSessions(db, auth) },
  );
});
afterAll(async () => db.close());
it('projects the authenticated student, active guardians and exact current/historical enrollments without private fields or invented data', async () => {
  const r = await call();
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.headers['cache-control']).toBe('no-store');
  expect(r.body.student).toEqual({
    student_code: 'STU001',
    first_name: 'Aarav',
    last_name: 'Sharma',
    date_of_birth: '2012-02-29',
    gender: 'MALE',
    email: 'learner@example.invalid',
    phone: '+91 90000 10000',
    status: 'ACTIVE',
  });
  expect(r.body.school).toHaveProperty('name');
  expect(r.body.enrollments).toHaveLength(2);
  expect(r.body.enrollments.find((e: any) => e.is_current)).toMatchObject({
    grade: '8',
    section: 'A',
    roll_number: '08-A-17',
    session_name: 'Test year',
    starts_on: '2026-01-01',
    status: 'ACTIVE',
  });
  expect(r.body.enrollments.find((e: any) => !e.is_current)).toMatchObject({
    session_name: 'Earlier session',
    status: 'ENDED',
    starts_on: '2025-01-01',
    ends_on: '2025-12-31',
  });
  expect(r.body.guardians).toEqual([
    {
      full_name: 'Parent Test',
      relationship: 'GUARDIAN',
      email: 'parent@example.invalid',
      phone: '+91 90000 20000',
      is_primary_contact: false,
    },
  ]);
  const serialized = JSON.stringify(r.body);
  for (const value of [
    s.other,
    s.privateParent,
    f.studentUser,
    'Private learner',
    'Private guardian',
    'user_id',
    'no_names_on_lock_screen',
    'photo_url',
    'admission_date',
    'address',
  ])
    expect(serialized).not.toContain(value);
});
it('refuses ID overrides, other roles, anonymous callers and other school contexts', async () => {
  for (const key of ['student_id', 'user_id', 'id'])
    expect((await call(`/student/profile?${key}=${s.other}`)).status).toBe(422);
  expect((await call('/student/profile/' + s.other)).status).toBe(404);
  for (const role of ['parent', 'teacher', 'principal', 'admin'])
    expect((await call('/student/profile', role)).status).toBe(403);
  expect((await request(app).get('/api/v1/student/profile')).status).toBe(401);
  expect((await call().set('X-School-Id', f.schoolB)).status).toBe(404);
});
it('rejects profile writes and tampering with existing record APIs', async () => {
  for (const method of ['post', 'put', 'patch', 'delete'] as const)
    expect(
      (
        await request(app)
          [method]('/api/v1/student/profile')
          .set('Authorization', 'Bearer ' + fixtureBearer('student'))
          .set('X-School-Id', f.schoolA)
          .send({ first_name: 'Changed' })
      ).status,
    ).toBe(405);
  expect(
    (
      await request(app)
        .patch('/api/v1/resources/students/' + f.student)
        .set('Authorization', 'Bearer ' + fixtureBearer('student'))
        .set('X-School-Id', f.schoolA)
        .send({ first_name: 'Changed' })
    ).status,
  ).toBe(403);
  for (const id of [s.other, f.foreignStudent]) {
    expect((await call('/students/' + id + '/overview')).status).toBe(404);
    expect((await call('/resources/students/' + id)).status).toBe(404);
  }
  const list = await call('/resources/students');
  expect(list.body.data.map((row: any) => row.id)).toEqual([f.student]);
});
it('restricts direct runtime SQL to own student, family links, parents, classes, sessions and enrollments', async () => {
  await ownTx(async (tx) => {
    expect((await tx.query('SELECT id FROM students')).rows.map((r) => r.id)).toEqual([f.student]);
    expect((await tx.query('SELECT id FROM parents')).rows.map((r) => r.id)).toEqual([f.parentId]);
    expect(
      (await tx.query('SELECT student_id FROM student_parents')).rows.map((r) => r.student_id),
    ).toEqual([f.student]);
    expect(
      (await tx.query('SELECT student_id FROM enrollments')).rows.every(
        (r) => r.student_id === f.student,
      ),
    ).toBe(true);
    expect((await tx.query('SELECT id FROM classes')).rows.map((r) => r.id).sort()).toEqual(
      [f.classId, s.pastClass].sort(),
    );
    expect(
      (await tx.query('SELECT id FROM academic_sessions')).rows.map((r) => r.id).sort(),
    ).toEqual([f.session, s.pastSession].sort());
    expect(
      (
        await tx.query("SELECT app.student_profile_record_access($1,'parent',$2) AS allowed", [
          f.schoolA,
          s.privateParent,
        ])
      ).rows[0].allowed,
    ).toBe(false);
    expect(
      (
        await tx.query("SELECT app.student_profile_record_access($1,'parent',$2) AS allowed", [
          f.schoolB,
          f.parentId,
        ])
      ).rows[0].allowed,
    ).toBe(false);
  });
});
it('prevents direct database modification of every official profile relationship', async () => {
  for (const [table, field, value] of [
    ['students', 'first_name', 'Changed'],
    ['parents', 'full_name', 'Changed'],
    ['student_parents', 'relationship', 'OTHER'],
    ['enrollments', 'roll_number', 'Changed'],
    ['classes', 'section', 'Changed'],
    ['academic_sessions', 'name', 'Changed'],
  ]) {
    for (const [sql, args] of [
      [`UPDATE ${table} SET ${field}=$1 RETURNING id`, [value]],
      [`DELETE FROM ${table} RETURNING id`, []],
    ] as const) {
      try {
        const result = await ownTx((tx) => tx.query(sql, [...args]));
        expect(result.rows).toHaveLength(0);
      } catch (error) {
        expect((error as { code?: string }).code).toBe('42501');
      }
    }
  }
  await expect(
    ownTx((tx) =>
      tx.query(
        "INSERT INTO students(school_id,student_code,first_name) VALUES($1,'ILLEGAL','Changed')",
        [f.schoolA],
      ),
    ),
  ).rejects.toThrow(/row-level security|permission denied/);
});
it('hides revoked or inactive guardian links immediately, without exposing a sibling or other family', async () => {
  await db.query("UPDATE student_parents SET status='REVOKED' WHERE student_id=$1", [f.student]);
  expect((await call()).body.guardians).toEqual([]);
  await db.query("SELECT set_config('app.school_id',$1,false)", [f.schoolA]);
  await db.query("UPDATE student_parents SET status='ACTIVE' WHERE student_id=$1", [f.student]);
  await db.query("SELECT set_config('app.school_id','',false)");
  await db.query("UPDATE parents SET status='INACTIVE' WHERE id=$1", [f.parentId]);
  expect((await call()).body.guardians).toEqual([]);
  await db.query("UPDATE parents SET status='ACTIVE' WHERE id=$1", [f.parentId]);
});
it('does not mark future enrollment or an ended academic session as current', async () => {
  await db.query(
    "UPDATE enrollments SET starts_on='2027-01-01' WHERE student_id=$1 AND status='ACTIVE'",
    [f.student],
  );
  expect((await call()).body.enrollments.some((e: any) => e.is_current)).toBe(false);
  await db.query(
    "UPDATE enrollments SET starts_on='2026-01-01' WHERE student_id=$1 AND status='ACTIVE'",
    [f.student],
  );
  await db.query("UPDATE academic_sessions SET ends_on='2026-01-02' WHERE id=$1", [f.session]);
  expect((await call()).body.enrollments.some((e: any) => e.is_current)).toBe(false);
  await db.query("UPDATE academic_sessions SET ends_on='2027-12-31' WHERE id=$1", [f.session]);
});
it('handles absent fields and no current enrollment without inventing personal or admission details', async () => {
  await db.query(
    "UPDATE students SET last_name=NULL,date_of_birth=NULL,gender='NOT_SPECIFIED',email=NULL,status='TRANSFERRED' WHERE id=$1",
    [f.student],
  );
  await db.query("UPDATE enrollments SET status='ENDED' WHERE student_id=$1", [f.student]);
  const r = await call();
  expect(r.status).toBe(200);
  expect(r.body.student).toMatchObject({
    last_name: null,
    date_of_birth: null,
    gender: 'NOT_SPECIFIED',
    email: null,
    status: 'TRANSFERRED',
  });
  expect(r.body.enrollments.some((e: any) => e.is_current)).toBe(false);
  await db.query('UPDATE students SET user_id=NULL WHERE id=$1', [f.student]);
  expect((await call()).status).toBe(404);
  await db.query('UPDATE students SET user_id=$1 WHERE id=$2', [f.studentUser, f.student]);
});
it('keeps other role access and browser database restrictions intact and revokes disabled student memberships', async () => {
  await db.query("UPDATE students SET status='ACTIVE' WHERE id=$1", [f.student]);
  await db.query(
    "UPDATE enrollments SET status='ACTIVE' WHERE student_id=$1 AND starts_on='2026-01-01'",
    [f.student],
  );
  for (const role of ['admin', 'principal', 'teacher'])
    expect((await call('/students/' + f.student + '/overview', role)).status).toBe(200);
  expect((await call('/parent/children/' + f.student + '/profile', 'parent')).status).toBe(200);
  expect(
    (
      await db.query(
        "SELECT has_function_privilege('authenticated','app.student_profile_record_access(uuid,text,uuid)','EXECUTE') AS browser,has_table_privilege('authenticated','students','SELECT') AS records",
      )
    ).rows[0],
  ).toEqual({ browser: false, records: false });
  await db.query("UPDATE school_memberships SET status='SUSPENDED' WHERE user_id=$1", [
    f.studentUser,
  ]);
  expect((await call()).status).toBe(404);
  expect(await ownTx(async (tx) => (await tx.query('SELECT id FROM students')).rows)).toEqual([]);
});
