import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import { drainOutbox } from '../../apps/worker/src/outbox.js';
import * as providers from '../../apps/worker/src/providers.js';
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
  await db.query(
    'UPDATE teacher_class_assignments SET retired_at=now() WHERE school_id=$1 AND class_id=$2',
    [f.schoolA, s.otherClass],
  );
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
it('RLS independently prevents family writes and unassigned teacher reads', async () => {
  const row = await db.query(
    "INSERT INTO assignments(school_id,class_id,subject_id,kind,title,created_by,assigned_on) VALUES($1,$2,$3,'HOMEWORK','RLS-only test',$4,'2026-10-01') RETURNING id",
    [f.schoolA, s.otherClass, s.privateSubject, f.admin],
  );
  for (const userId of [f.studentUser, f.parent, f.teacher]) {
    const visible = await transaction(
      pools.api,
      { schoolId: f.schoolA, userId },
      async (tx) =>
        (await tx.query('SELECT id FROM assignments WHERE id=$1', [row.rows[0].id])).rows,
      true,
    );
    expect(visible).toEqual([]);
  }
  for (const userId of [f.studentUser, f.parent])
    await expect(
      transaction(pools.api, { schoolId: f.schoolA, userId }, (tx) =>
        tx.query(
          "INSERT INTO assignments(school_id,class_id,subject_id,kind,title,created_by) VALUES($1,$2,$3,'HOMEWORK','Forbidden',$4)",
          [f.schoolA, f.classId, f.subject, userId],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
});
const mutate = (method: 'post' | 'patch' | 'delete', path: string, role = 'admin') =>
  request(app)
    [method]('/api/v1' + path)
    .set('Authorization', 'Bearer ' + fixtureBearer(role))
    .set('X-School-Id', f.schoolA);
let homeworkId: string;
it('creates dated homework with its configured subject and queues one versioned notification', async () => {
  const response = await mutate('post', '/resources/assignments', 'teacher').send({
    class_id: f.classId,
    subject_id: f.subject,
    kind: 'HOMEWORK',
    title: 'Diary mathematics',
    body: 'Complete exercises',
    assigned_on: '2026-11-01',
    due_at: '2026-11-02T12:00:00Z',
    instructions: 'Show your work',
    reference_url: 'https://example.org/lesson',
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  homeworkId = response.body.id;
  const jobs = await db.query(
    "SELECT * FROM notification_outbox WHERE kind='HOMEWORK' AND payload->>'homework_id'=$1",
    [homeworkId],
  );
  expect(jobs.rows).toHaveLength(1);
  expect((jobs.rows[0] as any).payload.revision).toBe(1);
});
it('serves date and subject labels with month counts for each allowed role and checked parent child', async () => {
  for (const role of ['admin', 'teacher', 'principal', 'student', 'parent']) {
    const response = await call('/homework/diary?date=2026-11-01', role);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(
      response.body.data.some((r: any) => r.id === homeworkId && r.subject === 'Mathematics'),
    ).toBe(true);
    expect(response.body.dates).toContainEqual({ date: '2026-11-01', count: 1 });
  }
  const response = await call(
    `/parent/children/${f.student}/homework/diary?date=2026-11-01`,
    'parent',
  );
  expect(response.status).toBe(200);
  expect(response.body.data[0].id).toBe(homeworkId);
  expect(
    (await call(`/parent/children/${f.foreignStudent}/homework/diary?date=2026-11-01`, 'parent'))
      .status,
  ).toBe(404);
});
it('rejects unassigned teacher classes/subjects, invalid deadlines and unsafe reference URLs', async () => {
  const data = {
    class_id: s.otherClass,
    subject_id: f.subject,
    kind: 'HOMEWORK',
    title: 'Not allowed',
    assigned_on: '2026-11-01',
  };
  expect((await mutate('post', '/resources/assignments', 'teacher').send(data)).status).not.toBe(
    201,
  );
  expect(
    (
      await mutate('post', '/resources/assignments').send({
        ...data,
        class_id: f.classId,
        reference_url: 'javascript:alert(1)',
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await mutate('post', '/resources/assignments').send({
        ...data,
        class_id: f.classId,
        due_at: '2026-10-01T00:00:00Z',
      })
    ).status,
  ).not.toBe(201);
  for (const role of ['parent', 'student', 'principal'])
    expect(
      (
        await mutate('patch', `/resources/assignments/${homeworkId}`, role).send({
          title: 'Forbidden',
        })
      ).status,
    ).toBe(403);
});
it('does not leak unassigned classes or calendar counts and rejects malformed dates', async () => {
  await db.query(
    "INSERT INTO assignments(school_id,class_id,subject_id,kind,title,created_by,assigned_on) VALUES($1,$2,$3,'HOMEWORK','PRIVATE DIARY',$4,'2026-11-03')",
    [f.schoolA, s.otherClass, s.privateSubject, f.admin],
  );
  for (const role of ['teacher', 'student', 'parent']) {
    const response = await call('/homework/diary?date=2026-11-03', role);
    expect(response.body.data).toEqual([]);
    expect(response.body.dates.some((d: any) => d.date === '2026-11-03')).toBe(false);
  }
  expect((await call('/homework/diary?date=2026-02-31')).status).toBe(422);
});
it('delivers homework only to enrolled students and authorized parents through the existing worker', async () => {
  const send = vi.spyOn(providers, 'deliver').mockResolvedValue('test-provider-accepted');
  try {
    await drainOutbox(pools.worker, f.schoolA, 'ab'.repeat(32));
    expect(send.mock.calls.some((args) => String(args[2]).includes('Diary mathematics'))).toBe(
      true,
    );
    const recipients = await db.query(
      "SELECT DISTINCT recipient_user_id,parent_id FROM notification_deliveries WHERE outbox_id IN (SELECT id FROM notification_outbox WHERE payload->>'homework_id'=$1) AND status='SENT'",
      [homeworkId],
    );
    expect(recipients.rows.some((r: any) => r.recipient_user_id === f.studentUser)).toBe(true);
    expect(recipients.rows.some((r: any) => r.parent_id === f.parentId)).toBe(true);
  } finally {
    send.mockRestore();
  }
});
it('updates and soft deletes homework without removing its historical record', async () => {
  const edited = await mutate('patch', `/resources/assignments/${homeworkId}`, 'teacher').send({
    instructions: 'Updated instructions',
  });
  expect(edited.status, JSON.stringify(edited.body)).toBe(200);
  expect(edited.body.diary_version).toBe(2);
  expect((await mutate('delete', `/homework/${homeworkId}`, 'student')).status).toBe(403);
  const deleted = await mutate('delete', `/homework/${homeworkId}`, 'teacher');
  expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
  const response = await call('/homework/diary?date=2026-11-01', 'student');
  expect(response.body.data).toEqual([]);
  const stored = await db.query('SELECT retired_at FROM assignments WHERE id=$1', [homeworkId]);
  expect(stored.rows).toHaveLength(1);
  expect((stored.rows[0] as any).retired_at).toBeTruthy();
});
it('keeps two authorized children diaries separate and suppresses removed homework versions',async()=>{
 await db.query("INSERT INTO student_parents(school_id,student_id,parent_id,relationship) VALUES($1,$2,$3,'GUARDIAN')",[f.schoolA,s.otherStudent,f.parentId]);
 const first=await call(`/parent/children/${f.student}/homework/diary?date=2026-11-03`,'parent');
 const second=await call(`/parent/children/${s.otherStudent}/homework/diary?date=2026-11-03`,'parent');
 expect(first.status).toBe(200);expect(first.body.data).toEqual([]);
 expect(second.status).toBe(200);expect(second.body.data.map((r:any)=>r.title)).toEqual(['PRIVATE DIARY']);
 const send=vi.spyOn(providers,'deliver').mockResolvedValue('must-not-send');
 try{await drainOutbox(pools.worker,f.schoolA,'ab'.repeat(32));expect(send).not.toHaveBeenCalled();}finally{send.mockRestore();}
 expect((await call('/homework/diary?date=2026-11-03','student').set('X-School-Id',f.schoolB)).status).toBe(404);
});
