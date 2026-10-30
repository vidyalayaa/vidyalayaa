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
  app: ReturnType<typeof createApp>;
let material: string,
  otherClass: string,
  otherSubject: string,
  otherChild: string,
  otherMaterial: string;
const bytes = Buffer.from('%PDF-1.4\nSubject material fixture\n%%EOF'),
  objects = new Map<string, Buffer>();
const call = (method: 'get' | 'post' | 'patch', path: string, role = 'admin') =>
  request(app)
    [method]('/api/v1' + path)
    .set('Authorization', 'Bearer ' + fixtureBearer(role))
    .set('X-School-Id', f.schoolA);
const list = (role = 'student', classId = f.classId, subject = f.subject) =>
  call('get', `/materials?class_id=${classId}&subject_id=${subject}`, role);
beforeAll(async () => {
  db = await portableDatabase();
  f = await fixture(db);
  pools = poolAdapters(db);
  const identities: Record<string, string> = {
    admin: f.admin,
    teacher: f.teacher,
    student: f.studentUser,
    parent: f.parent,
    principal: f.principal,
  };
  const auth = {
    auth: {
      getUser: async (token: string) => ({
        data: { user: identities[token] ? { id: identities[token] } : null },
        error: null,
      }),
    },
    storage: {
      from: () => ({
        createSignedUploadUrl: async (path: string) => ({
          data: { path, token: 'test-upload-token' },
          error: null,
        }),
        download: async (path: string) => ({
          data: objects.has(path)
            ? new Blob([objects.get(path)!], { type: 'application/pdf' })
            : null,
          error: objects.has(path) ? null : { message: 'missing' },
        }),
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
  otherClass = crypto.randomUUID();
  otherSubject = crypto.randomUUID();
  otherChild = crypto.randomUUID();
  otherMaterial = crypto.randomUUID();
  await db.query(
    "INSERT INTO classes(id,school_id,academic_session_id,grade,section) VALUES($1,$2,$3,'9','B')",
    [otherClass, f.schoolA, f.session],
  );
  await db.query(
    "INSERT INTO subjects(id,school_id,code,name) VALUES($1,$2,'PRIVATE_MAT','Other section subject')",
    [otherSubject, f.schoolA],
  );
  // The same teacher teaches another subject in the first class, but not this
  // second section: class and exact subject permissions must both be enforced.
  const otherTeacher = crypto.randomUUID();
  await db.query(
    "INSERT INTO teachers(id,school_id,staff_code,full_name) VALUES($1,$2,'OTHER_MAT','Other teacher')",
    [otherTeacher, f.schoolA],
  );
  await db.query(
    "INSERT INTO teacher_class_assignments(school_id,class_id,subject_id,teacher_id,starts_on) VALUES($1,$2,$3,$4,'2026-01-01'),($1,$5,$3,$4,'2026-01-01')",
    [f.schoolA, f.classId, otherSubject, otherTeacher, otherClass],
  );
  await db.query(
    "INSERT INTO students(id,school_id,student_code,first_name) VALUES($1,$2,'OTHER_MATERIAL','Other child')",
    [otherChild, f.schoolA],
  );
  await db.query(
    "INSERT INTO enrollments(school_id,class_id,academic_session_id,student_id,starts_on) VALUES($1,$2,$3,$4,'2026-01-01')",
    [f.schoolA, otherClass, f.session, otherChild],
  );
  await db.query(
    "INSERT INTO assignments(id,school_id,class_id,subject_id,kind,title,created_by,storage_path) VALUES($1,$2,$3,$4,'MATERIAL','Private other section material',$5,$6)",
    [
      otherMaterial,
      f.schoolA,
      otherClass,
      otherSubject,
      f.admin,
      `${f.schoolA}/materials/${otherClass}/private.pdf`,
    ],
  );
  objects.set(`${f.schoolA}/materials/${otherClass}/private.pdf`, bytes);
});
afterAll(async () => db.close());
it('admin and assigned teacher share the existing upload/create workflow with idempotency', async () => {
  const ticket = await call('post', '/materials/upload', 'teacher').send({
    class_id: f.classId,
    subject_id: f.subject,
    filename: 'chapter-one.pdf',
  });
  expect(ticket.status, JSON.stringify(ticket.body)).toBe(200);
  objects.set(ticket.body.path, bytes);
  const body = {
    class_id: f.classId,
    subject_id: f.subject,
    kind: 'MATERIAL',
    title: 'Chapter one',
    body: 'Read the notes.',
    storage_path: ticket.body.path,
  };
  const key = crypto.randomUUID();
  const created = await call('post', '/resources/assignments', 'teacher')
    .set('Idempotency-Key', key)
    .send(body);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  material = created.body.id;
  const retry = await call('post', '/resources/assignments', 'teacher')
    .set('Idempotency-Key', key)
    .send(body);
  expect(retry.body.id).toBe(material);
  expect((await list('admin')).body.data.map((r: any) => r.id)).toEqual([material]);
});
it('students and parents list only exact class/subject materials and download authenticated files', async () => {
  for (const role of ['student', 'parent']) {
    const r = await list(role);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toHaveLength(1);
    expect(r.body.data[0]).toMatchObject({
      id: material,
      title: 'Chapter one',
      has_attachment: true,
    });
    expect(JSON.stringify(r.body)).not.toMatch(/storage_path|created_by|Private other/);
    const ticket = await call('get', `/materials/${material}/download`, role);
    expect(ticket.status).toBe(200);
    const file = await call('get', ticket.body.url, role);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toContain('application/pdf');
    expect(
      (
        await call(
          'get',
          ticket.body.url.replace(/signature=[^&]+/, 'signature=' + '0'.repeat(64)),
          role,
        )
      ).status,
    ).toBe(403);
    expect((await list(role, otherClass, otherSubject)).status).toBe(404);
    expect((await call('get', `/materials/${otherMaterial}/download`, role)).status).toBe(404);
    expect(
      (
        await call('post', '/materials/upload', role).send({
          class_id: f.classId,
          subject_id: f.subject,
          filename: 'bad.pdf',
        })
      ).status,
    ).toBe(403);
  }
});
it('teacher cannot upload, create, read or download materials in unassigned classes or subjects', async () => {
  for (const [classId, subject] of [
    [otherClass, otherSubject],
    [f.classId, otherSubject],
  ]) {
    expect((await list('teacher', classId, subject)).status).toBe(404);
    expect(
      (
        await call('post', '/materials/upload', 'teacher').send({
          class_id: classId,
          subject_id: subject,
          filename: 'not-assigned.pdf',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call('post', '/resources/assignments', 'teacher').send({
          class_id: classId,
          subject_id: subject,
          kind: 'MATERIAL',
          title: 'Forbidden',
          body: 'Other subject',
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
  }
  expect((await call('get', `/materials/${otherMaterial}/download`, 'teacher')).status).toBe(404);
});
it('child-specific parent access follows the selected child, link revocation and school context', async () => {
  const base = `/parent/children/${f.student}/materials`;
  expect(
    (await call('get', `${base}?class_id=${f.classId}&subject_id=${f.subject}`, 'parent')).body
      .data[0].id,
  ).toBe(material);
  expect(
    (
      await call(
        'get',
        `/parent/children/${otherChild}/materials?class_id=${otherClass}&subject_id=${otherSubject}`,
        'parent',
      )
    ).status,
  ).toBe(404);
  await db.query("SELECT set_config('app.school_id',$1,false)", [f.schoolA]);
  await db.query(
    "INSERT INTO student_parents(school_id,student_id,parent_id,relationship) VALUES($1,$2,$3,'GUARDIAN')",
    [f.schoolA, otherChild, f.parentId],
  );
  await db.query("SELECT set_config('app.school_id','',false)");
  expect(
    (await call('get', `${base}?class_id=${otherClass}&subject_id=${otherSubject}`, 'parent'))
      .status,
  ).toBe(404);
  expect(
    (
      await call(
        'get',
        `/parent/children/${otherChild}/materials?class_id=${otherClass}&subject_id=${otherSubject}`,
        'parent',
      )
    ).body.data[0].id,
  ).toBe(otherMaterial);
  expect((await list('student').set('X-School-Id', f.schoolB)).status).toBe(404);
  const link = await call('get', `/materials/${material}/download`, 'parent');
  await db.query("UPDATE student_parents SET status='REVOKED' WHERE student_id=$1", [f.student]);
  expect((await call('get', link.body.url, 'parent')).status).toBe(404);
});
it('student RLS independently restricts materials to current own classes and denies writes', async () => {
  const ctx = { schoolId: f.schoolA, userId: f.studentUser };
  const rows = await transaction(
    pools.api,
    ctx,
    async (tx) => (await tx.query('SELECT id FROM assignments')).rows,
    true,
  );
  expect(rows.map((r) => r.id)).toEqual([material]);
  expect(
    (
      await transaction(pools.api, ctx, (tx) =>
        tx.query("UPDATE assignments SET title='Tampered' RETURNING id"),
      )
    ).rowCount,
  ).toBe(0);
  await expect(
    transaction(pools.api, ctx, (tx) =>
      tx.query(
        "INSERT INTO assignments(school_id,class_id,subject_id,kind,title,created_by) VALUES($1,$2,$3,'MATERIAL','Forbidden',$4)",
        [f.schoolA, f.classId, f.subject, f.studentUser],
      ),
    ),
  ).rejects.toMatchObject({ code: '42501' });
  await db.query("UPDATE enrollments SET status='ENDED' WHERE student_id=$1", [f.student]);
  expect((await list('student')).status).toBe(404);
  expect((await call('get', `/materials/${material}/download`, 'student')).status).toBe(404);
});
