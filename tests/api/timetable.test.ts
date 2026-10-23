import { beforeAll, afterAll, it, expect } from 'vitest';
import request from 'supertest';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { portableDatabase, poolAdapters, fixture } from '../helpers/database.js';
import { createApp } from '../../apps/api/src/app.js';
import { transaction } from '../../apps/api/src/lib/db.js';
import type { Config } from '../../apps/api/src/lib/config.js';
import { defaultSchoolTimings } from '@vidyalayaa/contracts';
let db: PGlite,
  f: Awaited<ReturnType<typeof fixture>>,
  app: ReturnType<typeof createApp>,
  other: string;
const call = (method: 'get' | 'post' | 'put' | 'patch', path: string, role = 'admin') =>
  request(app)
    [method]('/api/v1' + path)
    .set('Authorization', 'Bearer ' + role)
    .set('X-School-Id', f.schoolA);
const lecture = () => ({
  class_id: f.classId,
  subject_id: f.subject,
  teacher_id: f.teacherId,
  weekday: 1,
  starts_at: '08:00',
  ends_at: '08:40',
  room: 'A1',
});
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
  app = createApp(
    {
      NODE_ENV: 'test',
      WEB_ORIGINS: 'http://localhost:5173',
      TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32),
      TRUST_PROXY_HOPS: 0,
    } as Config,
    { ...poolAdapters(db), supabase },
  );
  const teacher = (
    await call('post', '/resources/teachers').send({
      staff_code: 'TIMETABLE_B',
      full_name: 'Other teacher',
    })
  ).body.id;
  other = (
    await call('post', '/resources/classes').send({
      academic_session_id: f.session,
      grade: '9',
      section: 'B',
      class_teacher_id: teacher,
    })
  ).body.id;
});
afterAll(async () => db.close());
it('reads existing timetable defaults without persisting synthetic school settings, then saves and versions timing configuration', async () => {
  const before = await call('get', '/timetable/settings');
  expect(before.status, JSON.stringify(before.body)).toBe(200);
  expect(before.body.configured).toBe(false);
  const r = await call('put', '/timetable/settings')
    .set('Idempotency-Key', crypto.randomUUID())
    .send({ expected_version: 0, settings: defaultSchoolTimings });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body.version).toBe(1);
  expect(
    (
      await call('put', '/timetable/settings').send({
        expected_version: 0,
        settings: defaultSchoolTimings,
      })
    ).status,
  ).toBe(409);
});
it('creates, edits and archives lectures through existing CRUD and rejects class/teacher overlap', async () => {
  const r = await call('post', '/resources/timetable_entries').send(lecture());
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  expect((await call('post', '/resources/timetable_entries').send(lecture())).status).toBe(409);
  expect(
    (
      await call('patch', '/resources/timetable_entries/' + r.body.id).send({
        starts_at: '08:40',
        ends_at: '09:20',
        room: 'A2',
      })
    ).status,
  ).toBe(200);
  expect(
    (await call('get', '/timetable/classes/' + f.classId + '/entries')).body.data[0].room,
  ).toBe('A2');
  expect(
    (
      await call('post', '/resources/timetable_entries/' + r.body.id + '/retire').send({
        reason: 'Replace classroom lecture',
      })
    ).status,
  ).toBe(204);
  expect((await call('get', '/timetable/classes/' + f.classId + '/entries')).body.total).toBe(0);
  expect(
    (await db.query('SELECT retired_at FROM timetable_entries WHERE id=$1', [r.body.id])).rows[0]
      .retired_at,
  ).toBeTruthy();
});
it('rejects invalid days/periods and teachers not assigned to the selected class and subject', async () => {
  for (const patch of [
    { weekday: 7 },
    { starts_at: '08:05' },
    { class_id: other },
    { teacher_id: crypto.randomUUID() },
    { subject_id: crypto.randomUUID() },
  ]) {
    const r = await call('post', '/resources/timetable_entries').send({ ...lecture(), ...patch });
    expect([404, 422]).toContain(r.status);
  }
  const r = await call('get', `/timetable/classes/${f.classId}/assignments`);
  expect(r.status).toBe(200);
  expect(r.body.data).toHaveLength(1);
  expect(r.body.data[0].teacher_id).toBe(f.teacherId);
});
it('enforces read-only roles and current class visibility in API and direct database queries', async () => {
  const r = await call('post', '/resources/timetable_entries').send({ ...lecture(), weekday: 2 });
  expect(r.status).toBe(201);
  for (const role of ['teacher', 'student', 'parent', 'principal']) {
    expect(
      (await call('get', '/timetable/classes/' + f.classId + '/entries', role)).body.total,
    ).toBe(1);
    expect((await call('post', '/resources/timetable_entries', role).send(lecture())).status).toBe(
      403,
    );
    expect(
      (
        await call('put', '/timetable/settings', role).send({
          expected_version: 1,
          settings: defaultSchoolTimings,
        })
      ).status,
    ).toBe(403);
    expect(
      (await call('get', '/timetable/classes/' + f.classId + '/assignments', role)).status,
    ).toBe(403);
  }
  for (const role of ['teacher', 'student', 'parent'])
    expect((await call('get', '/timetable/classes/' + other + '/entries', role)).status).toBe(404);
  expect((await call('get', '/timetable/classes/' + other + '/entries', 'principal')).status).toBe(
    200,
  );
  await expect(
    transaction(poolAdapters(db).api, { schoolId: f.schoolA, userId: f.studentUser }, (tx) =>
      tx.query(
        "UPDATE schools SET settings=jsonb_set(settings,'{timetable,version}','2') WHERE id=$1",
        [f.schoolA],
      ),
    ),
  ).rejects.toThrow(/TIMETABLE_ADMIN_REQUIRED/);
  await expect(
    transaction(poolAdapters(db).api, { schoolId: f.schoolA, userId: f.admin }, (tx) =>
      tx.query(
        "INSERT INTO timetable_entries(school_id,class_id,subject_id,teacher_id,weekday,starts_at,ends_at) VALUES($1,$2,$3,$4,1,'08:00','08:40')",
        [f.schoolA, other, f.subject, f.teacherId],
      ),
    ),
  ).rejects.toThrow(/TIMETABLE_ASSIGNMENT_INVALID/);
});
it('validates overlapping breaks and lectures before saving and guards SQL configuration writes', async () => {
  const invalid = {
    ...defaultSchoolTimings,
    breaks: [{ label: 'Break', start_time: '08:20', end_time: '08:30' }],
  };
  expect(
    (await call('put', '/timetable/settings').send({ expected_version: 1, settings: invalid }))
      .status,
  ).toBe(422);
  await expect(
    transaction(poolAdapters(db).api, { schoolId: f.schoolA, userId: f.admin }, (tx) =>
      tx.query(
        "UPDATE schools SET settings=jsonb_set(settings,'{timetable}',$2::jsonb) WHERE id=$1",
        [f.schoolA, JSON.stringify({ ...invalid, version: 2 })],
      ),
    ),
  ).rejects.toThrow(/TIMETABLE_TIMINGS_INVALID/);
});
it('prevents cross-class teacher double booking even when both assignments are valid', async () => {
  const c = (
    await call('post', '/resources/classes').send({
      academic_session_id: f.session,
      grade: '10',
      section: 'CONFLICT',
      class_teacher_id: f.teacherId,
    })
  ).body.id;
  expect(
    (
      await call('post', '/resources/teacher_class_assignments').send({
        teacher_id: f.teacherId,
        class_id: c,
        subject_id: f.subject,
        starts_on: '2026-01-01',
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await call('post', '/resources/timetable_entries').send({
        ...lecture(),
        class_id: c,
        weekday: 2,
      })
    ).status,
  ).toBe(409);
  await expect(
    transaction(poolAdapters(db).api, { schoolId: f.schoolA, userId: f.admin }, (tx) =>
      tx.query(
        "INSERT INTO timetable_entries(school_id,class_id,subject_id,teacher_id,weekday,starts_at,ends_at) VALUES($1,$2,$3,$4,2,'08:00','08:40')",
        [f.schoolA, c, f.subject, f.teacherId],
      ),
    ),
  ).rejects.toThrow(/teacher_no_overlap/);
});
it('keeps timing retries idempotent, preserves unrelated settings and refuses writes in read-only subscriptions', async () => {
  await db.query(
    "UPDATE schools SET settings=jsonb_set(settings,'{existing_note}','\"preserve\"'::jsonb) WHERE id=$1",
    [f.schoolA],
  );
  const version = (await call('get', '/timetable/settings')).body.version,
    key = crypto.randomUUID(),
    body = { expected_version: version, settings: defaultSchoolTimings };
  const saved = await call('put', '/timetable/settings').set('Idempotency-Key', key).send(body);
  expect(saved.status).toBe(200);
  expect(
    (await call('put', '/timetable/settings').set('Idempotency-Key', key).send(body)).body,
  ).toEqual(saved.body);
  expect(
    (
      await db.query("SELECT settings->>'existing_note' AS note FROM schools WHERE id=$1", [
        f.schoolA,
      ])
    ).rows[0].note,
  ).toBe('preserve');
  await db.query("UPDATE subscriptions SET status='SUSPENDED_READONLY' WHERE school_id=$1", [
    f.schoolA,
  ]);
  try {
    expect(
      (
        await call('put', '/timetable/settings').send({
          expected_version: saved.body.version,
          settings: defaultSchoolTimings,
        })
      ).status,
    ).toBe(403);
    expect(
      (await call('post', '/resources/timetable_entries').send({ ...lecture(), weekday: 4 }))
        .status,
    ).toBe(403);
    expect((await call('get', '/timetable/classes/' + f.classId + '/entries')).status).toBe(200);
  } finally {
    await db.query("UPDATE subscriptions SET status='ACTIVE' WHERE school_id=$1", [f.schoolA]);
  }
});
it('keeps legacy lectures after timing changes, permits room edits and validates rescheduling against the new periods', async () => {
  const config = {
    ...defaultSchoolTimings,
    days: [1, 2, 3, 4, 5],
    start_time: '10:00',
    lecture_count: 1,
    periods: [{ number: 1, label: 'New lecture', start_time: '10:00', end_time: '10:40' }],
  };
  const version = (await call('get', '/timetable/settings')).body.version;
  expect(
    (await call('put', '/timetable/settings').send({ expected_version: version, settings: config }))
      .status,
  ).toBe(200);
  const old = (await call('get', '/timetable/classes/' + f.classId + '/entries')).body.data[0];
  expect(old.starts_at).toBe('08:00:00');
  expect(
    (
      await call('patch', '/resources/timetable_entries/' + old.id).send({
        room: 'Preserved lecture room',
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call('patch', '/resources/timetable_entries/' + old.id).send({
        starts_at: '10:00',
        ends_at: '10:40',
      })
    ).status,
  ).toBe(200);
  expect((await call('get', '/timetable/classes/' + f.classId + '/entries')).body.data[0].id).toBe(
    old.id,
  );
});
it('applies ownership inside RLS and immediately revokes parent/student access after their link or enrollment ends', async () => {
  await db.query(
    "INSERT INTO timetable_entries(school_id,class_id,subject_id,teacher_id,weekday,starts_at,ends_at) VALUES($1,$2,$3,$4,3,'14:00','14:40')",
    [f.schoolA, other, f.subject, f.teacherId],
  );
  for (const userId of [f.parent, f.studentUser, f.teacher])
    await transaction(poolAdapters(db).api, { schoolId: f.schoolA, userId }, async (tx) => {
      expect(
        (await tx.query('SELECT id FROM timetable_entries WHERE class_id=$1', [other])).rows,
      ).toEqual([]);
      expect(
        (await tx.query('UPDATE timetable_entries SET room=$1 RETURNING id', ['Forbidden room']))
          .rows,
      ).toEqual([]);
    });
  await expect(
    transaction(poolAdapters(db).api, { schoolId: f.schoolA, userId: f.teacher }, (tx) =>
      tx.query(
        "INSERT INTO timetable_entries(school_id,class_id,subject_id,teacher_id,weekday,starts_at,ends_at) VALUES($1,$2,$3,$4,3,'10:00','10:40')",
        [f.schoolA, f.classId, f.subject, f.teacherId],
      ),
    ),
  ).rejects.toThrow(/TIMETABLE_ADMIN_REQUIRED|row-level security/);
  await db.query(
    "UPDATE student_parents SET status='REVOKED' WHERE school_id=$1 AND student_id=$2",
    [f.schoolA, f.student],
  );
  expect((await call('get', '/timetable/classes/' + f.classId + '/entries', 'parent')).status).toBe(
    404,
  );
  await db.query("UPDATE enrollments SET status='ENDED' WHERE school_id=$1 AND student_id=$2", [
    f.schoolA,
    f.student,
  ]);
  expect(
    (await call('get', '/timetable/classes/' + f.classId + '/entries', 'student')).status,
  ).toBe(404);
  expect((await call('get', '/timetable/classes/' + crypto.randomUUID() + '/entries')).status).toBe(
    404,
  );
  expect((await call('get', '/timetable/classes').set('X-School-Id', f.schoolB)).status).toBe(404);
});
