import { beforeAll, afterAll, it, expect } from 'vitest';
import request from 'supertest';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { portableDatabase, poolAdapters, fixture } from '../helpers/database.js';
import { createApp } from '../../apps/api/src/app.js';
import type { Config } from '../../apps/api/src/lib/config.js';
import { resolveRules } from '../../apps/api/src/modules/attendance/service.js';
import { transaction } from '../../apps/api/src/lib/db.js';
let db: PGlite,
  f: Awaited<ReturnType<typeof fixture>>,
  app: ReturnType<typeof createApp>,
  other: string,
  foreign: string;
const call = (method: 'get' | 'post' | 'patch' | 'delete', path: string, role = 'admin') =>
  request(app)
    [method]('/api/v1' + path)
    .set('Authorization', 'Bearer ' + role)
    .set('X-School-Id', f.schoolA);
const payload = (title: string, ids: string[] = [], kind = 'SCHOOL_EVENT') => ({
  title,
  description: 'Calendar details',
  kind,
  start_date: '2027-03-10',
  end_date: '2027-03-12',
  audience: ids.length ? 'CLASSES' : 'SCHOOL',
  class_ids: ids,
});
const create = async (title: string, ids: string[] = [], kind = 'SCHOOL_EVENT') => {
  const r = await call('post', '/calendar/events')
    .set('Idempotency-Key', crypto.randomUUID())
    .send(payload(title, ids, kind));
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
};
beforeAll(async () => {
  db = await portableDatabase();
  f = await fixture(db);
  const supabase = {
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
    { ...poolAdapters(db), supabase },
  );
  other = (
    await call('post', '/resources/classes').send({
      academic_session_id: f.session,
      grade: '8',
      section: 'B',
      class_teacher_id: f.teacherId,
    })
  ).body.id;
  const session = (
    await db.query<{ id: string }>(
      "INSERT INTO academic_sessions(school_id,name,starts_on,ends_on) VALUES($1,'Foreign','2026-01-01','2027-12-31') RETURNING id",
      [f.schoolB],
    )
  ).rows[0].id;
  foreign = (
    await db.query<{ id: string }>(
      "INSERT INTO classes(school_id,academic_session_id,grade,section) VALUES($1,$2,'9','Z') RETURNING id",
      [f.schoolB, session],
    )
  ).rows[0].id;
});
afterAll(async () => db.close());

it('limits teacher visibility to assigned sections, preserves Principal visibility and filters mixed audience labels', async () => {
  const teacher = await call('post', '/resources/teachers').send({
    staff_code: 'CALENDAR_OTHER_TEACHER',
    full_name: 'Other calendar teacher',
  });
  const section = await call('post', '/resources/classes').send({
    academic_session_id: f.session,
    grade: '9',
    section: 'CAL_UNASSIGNED',
    class_teacher_id: teacher.body.id,
  });
  expect(section.status).toBe(201);
  const hidden = await create('Unassigned teacher event', [section.body.id]),
    mixed = await create('Mixed teacher audience', [f.classId, section.body.id]);
  expect((await call('get', '/calendar/events/' + hidden.id, 'teacher')).status).toBe(404);
  expect((await call('get', '/calendar/events/' + hidden.id, 'principal')).status).toBe(200);
  const visible = await call('get', '/calendar/events/' + mixed.id, 'teacher');
  expect(visible.status).toBe(200);
  expect(visible.body.class_ids).toEqual([f.classId]);
  expect(visible.body.targets.map((c: any) => c.id)).toEqual([f.classId]);
});
it('shows a parent every authorized child section but no other student identity and ignores future/ended enrollments', async () => {
  const b = await create('Authorized sibling section', [other]);
  expect((await call('get', '/calendar/events/' + b.id, 'parent')).status).toBe(404);
  const student = await call('post', '/resources/students').send({
    student_code: 'CALENDAR_SIBLING',
    first_name: 'Calendar sibling',
  });
  const en = await call('post', '/resources/enrollments').send({
    student_id: student.body.id,
    class_id: other,
    academic_session_id: f.session,
    starts_on: '2099-01-01',
  });
  const link = await call('post', '/resources/student_parents').send({
    student_id: student.body.id,
    parent_id: f.parentId,
    relationship: 'GUARDIAN',
  });
  expect(link.status).toBe(201);
  expect((await call('get', '/calendar/events/' + b.id, 'parent')).status).toBe(404);
  expect(
    (await call('patch', '/resources/enrollments/' + en.body.id).send({ starts_on: '2026-01-01' }))
      .status,
  ).toBe(200);
  expect((await call('get', '/calendar/events/' + b.id, 'parent')).status).toBe(200);
  expect((await call('get', '/calendar/events/' + b.id, 'studentUser')).status).toBe(404);
  expect(
    (await call('patch', '/resources/enrollments/' + en.body.id).send({ status: 'ENDED' })).status,
  ).toBe(200);
  expect((await call('get', '/calendar/events/' + b.id, 'parent')).status).toBe(404);
});
it('rejects calendar changes for a read-only subscription without saving rows or calendar audits', async () => {
  await db.query("UPDATE subscriptions SET status='SUSPENDED_READONLY' WHERE school_id=$1", [
    f.schoolA,
  ]);
  try {
    expect(
      (
        await call('post', '/calendar/events').send(
          payload('Subscription forbidden calendar event'),
        )
      ).status,
    ).toBe(403);
  } finally {
    await db.query("UPDATE subscriptions SET status='ACTIVE' WHERE school_id=$1", [f.schoolA]);
  }
  expect(
    (
      await db.query(
        "SELECT id FROM school_holidays WHERE label='Subscription forbidden calendar event'",
      )
    ).rows,
  ).toEqual([]);
});
it('stores one multi-day event for several sections, supports overlap/type/class filters and safe retries', async () => {
  const body = payload('Multi section event', [other, f.classId]),
    key = crypto.randomUUID();
  const r = await call('post', '/calendar/events').set('Idempotency-Key', key).send(body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  expect(r.body).toMatchObject({
    title: body.title,
    start_date: body.start_date,
    end_date: body.end_date,
    audience: 'CLASSES',
    version: 1,
  });
  expect(r.body.targets).toHaveLength(2);
  expect(
    (await call('post', '/calendar/events').set('Idempotency-Key', key).send(body)).body,
  ).toEqual(r.body);
  expect(
    (await db.query('SELECT count(*)::int AS n FROM school_holidays WHERE id=$1', [r.body.id]))
      .rows[0].n,
  ).toBe(1);
  const duplicate = await call('post', '/calendar/events').send({
    ...body,
    title: '  MULTI   SECTION EVENT ',
    class_ids: [f.classId, other],
  });
  expect(duplicate.status).toBe(409);
  expect(
    (
      await call(
        'get',
        `/calendar/events?from=2027-03-11&to=2027-03-11&class_ids=${other}&kind=SCHOOL_EVENT`,
      )
    ).body.data.map((e: any) => e.id),
  ).toContain(r.body.id);
  expect(
    (await call('get', '/calendar/events?from=2027-03-13&to=2027-03-13')).body.data.map(
      (e: any) => e.id,
    ),
  ).not.toContain(r.body.id);
});
it('edits date/type/targets atomically, rejects stale saves and retires without deleting history', async () => {
  const saved = await create('Editable event', [f.classId]);
  const body = { ...payload('Edited event', [other], 'ACTIVITY'), expected_version: saved.version };
  const updated = await call('patch', '/calendar/events/' + saved.id).send(body);
  expect(updated.status, JSON.stringify(updated.body)).toBe(200);
  expect(updated.body).toMatchObject({
    title: 'Edited event',
    kind: 'ACTIVITY',
    class_ids: [other],
    version: 2,
  });
  expect((await call('patch', '/calendar/events/' + saved.id).send(body)).body.error.code).toBe(
    'CALENDAR_VERSION_CONFLICT',
  );
  expect(
    (await call('delete', '/calendar/events/' + saved.id).send({ expected_version: 1 })).status,
  ).toBe(409);
  const deleted = await call('delete', '/calendar/events/' + saved.id)
    .set('Idempotency-Key', 'calendar-delete-' + crypto.randomUUID())
    .send({ expected_version: 2 });
  expect(deleted.status).toBe(200);
  expect((await call('get', '/calendar/events/' + saved.id)).status).toBe(404);
  expect(
    (await db.query('SELECT retired_at FROM school_holidays WHERE id=$1', [saved.id])).rows[0]
      .retired_at,
  ).toBeTruthy();
  expect(
    (
      await db.query(
        "SELECT action FROM audit_logs WHERE entity_id=$1 AND action LIKE 'calendar.%' ORDER BY action",
        [saved.id],
      )
    ).rows.map((r: any) => r.action),
  ).toEqual(['calendar.create', 'calendar.delete', 'calendar.update']);
});
it('restricts families to current own/linked enrollment, including school-wide events and immediate link revocation', async () => {
  const all = await create('Everyone calendar event'),
    a = await create('Class A calendar event', [f.classId]),
    b = await create('Class B private event', [other]);
  for (const role of ['parent', 'studentUser']) {
    const list = await call('get', '/calendar/events?from=2027-03-01&to=2027-03-31', role);
    expect(list.status).toBe(200);
    const ids = list.body.data.map((x: any) => x.id);
    expect(ids).toContain(all.id);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id);
    expect((await call('get', '/calendar/events/' + b.id, role)).status).toBe(404);
    expect((await call('get', '/calendar/classes', role)).body.data.map((x: any) => x.id)).toEqual([
      f.classId,
    ]);
    expect(
      (await call('get', `/calendar/events?from=2027-03-01&to=2027-03-31&class_ids=${other}`, role))
        .status,
    ).toBe(404);
  }
  await db.query(
    "UPDATE student_parents SET status='REVOKED' WHERE school_id=$1 AND parent_id=$2",
    [f.schoolA, f.parentId],
  );
  expect((await call('get', '/calendar/events/' + a.id, 'parent')).status).toBe(404);
  expect((await call('get', '/calendar/events/' + all.id, 'parent')).status).toBe(200);
  await db.query("UPDATE student_parents SET status='ACTIVE' WHERE school_id=$1 AND parent_id=$2", [
    f.schoolA,
    f.parentId,
  ]);
});
it('enforces read/write role restrictions and foreign-school isolation in API and direct SQL', async () => {
  const e = await create('Permission event', [f.classId]);
  for (const role of ['parent', 'studentUser', 'teacher', 'principal']) {
    expect(
      (await call('post', '/calendar/events', role).send(payload('Forbidden ' + role))).status,
    ).toBe(403);
    expect(
      (
        await call('patch', '/calendar/events/' + e.id, role).send({
          ...payload('Forbidden'),
          expected_version: e.version,
        })
      ).status,
    ).toBe(403);
    expect(
      (await call('delete', '/calendar/events/' + e.id, role).send({ expected_version: e.version }))
        .status,
    ).toBe(403);
  }
  expect((await call('post', '/calendar/events').send(payload('Foreign', [foreign]))).status).toBe(
    422,
  );
  const foreignEvent = (
    await db.query<{ id: string }>(
      "INSERT INTO school_holidays(school_id,on_date,kind,label,target_class_ids) VALUES($1,'2027-03-11','SCHOOL_EVENT','Foreign',ARRAY[$2::uuid]) RETURNING id",
      [f.schoolB, foreign],
    )
  ).rows[0].id;
  expect((await call('get', '/calendar/events/' + foreignEvent)).status).toBe(404);
  const privateB = await create('Direct SQL private B', [other]);
  await transaction(poolAdapters(db).api, { schoolId: f.schoolA, userId: f.parent }, async (tx) => {
    expect(
      (await tx.query('SELECT id FROM school_holidays WHERE id=$1', [privateB.id])).rows,
    ).toEqual([]);
    expect(
      (
        await tx.query('UPDATE school_holidays SET label=$2 WHERE id=$1 RETURNING id', [
          e.id,
          'Forbidden',
        ])
      ).rows,
    ).toEqual([]);
  });
  await expect(
    transaction(poolAdapters(db).api, { schoolId: f.schoolA, userId: f.studentUser }, (tx) =>
      tx.query(
        "INSERT INTO school_holidays(school_id,on_date,kind,label) VALUES($1,'2027-03-10','OTHER','Forbidden SQL')",
        [f.schoolA],
      ),
    ),
  ).rejects.toThrow(/row-level security/);
  await expect(
    db.query(
      "INSERT INTO school_holidays(school_id,on_date,kind,label,target_class_ids) VALUES($1,'2027-03-10','OTHER','Foreign SQL',ARRAY[$2::uuid])",
      [f.schoolA, foreign],
    ),
  ).rejects.toThrow(/CALENDAR_TARGET_INVALID/);
});
it('validates calendar dates, audience and target lists before saving any event', async () => {
  for (const patch of [
    { end_date: '2027-03-01' },
    { audience: 'CLASSES', class_ids: [] },
    { audience: 'SCHOOL', class_ids: [f.classId] },
    { kind: 'INVALID' },
    { class_ids: [f.classId, f.classId], audience: 'CLASSES' },
    { title: '' },
  ])
    expect(
      (await call('post', '/calendar/events').send({ ...payload('Invalid'), ...patch })).status,
    ).toBe(422);
  expect((await call('get', '/calendar/events?from=2026-01-01&to=2028-01-01')).status).toBe(422);
});
it('keeps multi-day and targeted attendance holidays working while informational events never close school', async () => {
  await create('Attendance holiday', [f.classId], 'HOLIDAY');
  await create('Informational activity', [f.classId], 'ACTIVITY');
  const resolve = (cid: string, date: string) =>
    transaction(poolAdapters(db).device, { schoolId: f.schoolA, actorType: 'DEVICE' }, (tx) =>
      resolveRules(tx, f.schoolA, cid, date),
    );
  expect((await resolve(f.classId, '2027-03-11')).holiday).toBe(true);
  expect((await resolve(other, '2027-03-11')).holiday).toBe(false);
  expect((await resolve(f.classId, '2027-03-13')).holiday).toBe(false);
});
