import { beforeAll, afterAll, it, expect } from 'vitest';
import request from 'supertest';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { portableDatabase, poolAdapters, fixture } from '../helpers/database.js';
import { fixtureBearer, withProviderSessions } from '../helpers/provider-sessions.js';
import { parentScenario } from '../helpers/parent-workspace.js';
import { createApp } from '../../apps/api/src/app.js';
import type { Config } from '../../apps/api/src/lib/config.js';
import { transaction } from '../../apps/api/src/lib/db.js';
import { sampleRule } from '../../apps/web/src/features/resources/metadata.js';
import { defaultSchoolTimings } from '@vidyalayaa/contracts';
let db: PGlite,
  f: Awaited<ReturnType<typeof fixture>>,
  s: Awaited<ReturnType<typeof parentScenario>>,
  app: ReturnType<typeof createApp>,
  pools: ReturnType<typeof poolAdapters>;
const call = (path: string, role = 'parent', method: 'get' | 'post' | 'patch' | 'delete' = 'get') =>
  request(app)
    [method]('/api/v1' + path)
    .set('Authorization', 'Bearer ' + fixtureBearer(role))
    .set('X-School-Id', f.schoolA);
const base = (id: string) => '/parent/children/' + id;
beforeAll(async () => {
  db = await portableDatabase();
  f = await fixture(db);
  s = await parentScenario(db, f);
  pools = poolAdapters(db);
  const supabase = {
    auth: {
      getUser: async (token: string) => ({
        data: { user: { id: f[token as 'parent'] } },
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
    { ...pools, supabase: withProviderSessions(db, supabase) },
  );
});
afterAll(async () => db.close());
it('lists only active linked children with their current section and no private identity fields', async () => {
  const r = await call('/parent/children');
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body.children.map((c: any) => c.id).sort()).toEqual([f.student, s.sibling].sort());
  expect(r.body.children.find((c: any) => c.id === s.sibling).enrollment.section).toBe('B');
  expect(JSON.stringify(r.body)).not.toContain('user_id');
});
it('scopes every parent section to the selected child and published results', async () => {
  for (const [section, text] of [
    ['homework', 'First homework'],
    ['results', 'First exam'],
    ['fees', 'First tuition'],
    ['announcements', 'First announcement'],
  ]) {
    const r = await call(base(f.student) + '/' + section);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(JSON.stringify(r.body)).toContain(text);
    expect(JSON.stringify(r.body)).not.toMatch(
      /Sibling homework|Sibling exam|Sibling tuition|Sibling announcement|Private homework|Private exam|Private tuition|Private announcement|Staff private/,
    );
  }
  const sibling = await call(base(s.sibling) + '/homework');
  expect(sibling.body.data[0].title).toBe('Sibling homework');
  expect(
    (await call(base(f.student) + '/attendance')).body.data
      .filter((x: any) => x.id)
      .map((x: any) => x.id),
  ).toEqual([s.days[f.student]]);
  for (const section of [
    'profile',
    'academics',
    'reports',
    'notifications',
    'corrections',
    'payments',
  ])
    expect((await call(base(f.student) + '/' + section)).status, section).toBe(200);
});
it('rejects same-school other families, cross-school children and malformed identifiers on every section', async () => {
  for (const id of [s.privateChild, f.foreignStudent])
    for (const section of [
      'profile',
      'attendance',
      'academics',
      'homework',
      'results',
      'fees',
      'reports',
      'announcements',
      'notifications',
      'corrections',
      'calendar/classes',
      'timetable/classes',
    ])
      expect((await call(base(id) + '/' + section)).status, section).toBe(404);
  expect((await call(base('invalid') + '/profile')).status).toBe(422);
  expect((await call('/parent/children', 'teacher')).status).toBe(403);
});
it('filters calendar and timetable class options by selected child, even for authorized siblings', async () => {
  for (const module of ['calendar', 'timetable']) {
    const r = await call(base(f.student) + '/' + module + '/classes');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.map((c: any) => c.id)).toEqual([f.classId]);
  }
  const today = new Date().toISOString().slice(0, 10),
    r = await call(base(f.student) + `/calendar/events?from=${today}&to=${today}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body.data.map((e: any) => e.title)).toEqual(['First event']);
  expect(
    (await call(base(f.student) + '/timetable/classes/' + s.siblingClass + '/entries')).status,
  ).toBe(404);
});
it('accepts a linked-child correction request without changing the official record and rejects decisions or unrelated records', async () => {
  const r = await call('/corrections', 'parent', 'post').send({
    daily_attendance_id: s.days[f.student],
    requested_status: 'EXCUSED',
    reason: 'Please review this attendance record.',
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  expect(
    (
      await call('/corrections/' + r.body.id + '/decision', 'parent', 'post').send({
        approve: true,
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await call('/corrections', 'parent', 'post').send({
        daily_attendance_id: s.days[s.privateChild],
        requested_status: 'EXCUSED',
        reason: 'Unrelated family request',
      })
    ).status,
  ).toBe(404);
  expect((await call(base(f.student) + '/corrections')).body.data.map((x: any) => x.id)).toContain(
    r.body.id,
  );
  expect(
    (
      await db.query<{ attendance_status: string }>(
        'SELECT attendance_status FROM daily_attendance WHERE id=$1',
        [s.days[f.student]],
      )
    ).rows[0].attendance_status,
  ).toBe('PRESENT');
});
it('enforces database family ownership and denies official-record writes independently of the UI and API query filters', async () => {
  const ctx = { schoolId: f.schoolA, userId: f.parent };
  const visible = await transaction(pools.api, ctx, async (tx) => ({
    students: (await tx.query('SELECT id FROM students')).rows,
    classes: (await tx.query('SELECT id FROM classes')).rows,
    marks: (await tx.query('SELECT student_id FROM marks')).rows,
    exams: (await tx.query('SELECT id FROM exams')).rows,
  }));
  expect(visible.students.map((x) => x.id).sort()).toEqual([f.student, s.sibling].sort());
  expect(visible.classes.map((x) => x.id)).not.toContain(s.privateClass);
  expect(visible.marks.map((x) => x.student_id)).not.toContain(s.privateChild);
  expect(visible.exams.map((x) => x.id)).not.toContain(s.exams[s.privateChild]);
  const changed = await transaction(pools.api, ctx, (tx) =>
    tx.query("UPDATE students SET first_name='Forged' WHERE id=$1 RETURNING id", [f.student]),
  );
  expect(changed.rowCount).toBe(0);
  await expect(
    transaction(pools.api, ctx, (tx) =>
      tx.query(
        "INSERT INTO attendance_corrections(school_id,daily_attendance_id,requested_by,requested_status,reason,status) VALUES($1,$2,$3,'EXCUSED','Forged approval','APPLIED')",
        [f.schoolA, s.days[f.student], f.parent],
      ),
    ),
  ).rejects.toThrow();
  expect((await call('/resources/assignments/' + s.homeworks[s.privateChild])).status).toBe(404);
  expect((await call('/students/' + s.privateChild + '/overview')).status).toBe(404);
});
it('keeps staff access intact and rejects parent management endpoints', async () => {
  expect((await call('/resources/students', 'admin')).body.data.map((x: any) => x.id)).toContain(
    s.privateChild,
  );
  expect(
    (await call('/resources/students', 'principal')).body.data.map((x: any) => x.id),
  ).toContain(s.privateChild);
  for (const [path, method] of [
    ['/resources/students', 'post'],
    ['/attendance/manual', 'post'],
    ['/academics/classes', 'post'],
    ['/calendar/events', 'post'],
    ['/timetable/settings', 'patch'],
    ['/notifications/messages', 'post'],
  ] as const)
    expect((await call(path, 'parent', method).send({})).status).toBe(403);
});
it('keeps drafts, unrelated materials, other families reports and notifications private', async () => {
  const created = await call('/reports', 'parent', 'post').send({
    student_id: f.student,
    kind: 'ATTENDANCE',
    from: '2026-01-01',
    to: '2026-12-31',
  });
  expect(created.status, JSON.stringify(created.body)).toBe(202);
  expect((await call(base(f.student) + '/reports')).body.data.map((r: any) => r.id)).toContain(
    created.body.id,
  );
  expect((await call(base(s.sibling) + '/reports')).body.data).toEqual([]);
  expect(
    (
      await call('/reports', 'parent', 'post').send({
        student_id: s.privateChild,
        kind: 'ATTENDANCE',
        from: '2026-01-01',
        to: '2026-12-31',
      })
    ).status,
  ).toBe(404);
  expect((await call('/materials/' + s.homeworks[s.privateChild] + '/download')).status).toBe(404);
  await db.query("UPDATE exams SET status='OPEN' WHERE id=$1", [s.exams[f.student]]);
  expect((await call(base(f.student) + '/results')).body.data).toEqual([]);
  expect((await call('/resources/exams/' + s.exams[f.student])).status).toBe(404);
  await db.query("UPDATE exams SET status='PUBLISHED' WHERE id=$1", [s.exams[f.student]]);
  for (const [id, name] of [
    [f.student, 'First child alert'],
    [s.sibling, 'Sibling child alert'],
    [s.privateChild, 'Private child alert'],
  ]) {
    const outbox = (
      await db.query<{ id: string }>(
        "INSERT INTO notification_outbox(school_id,student_id,kind,dedupe_key,payload) VALUES($1,$2,'FEE_REMINDER',$3,$4) RETURNING id",
        [f.schoolA, id, crypto.randomUUID(), { title: name, body: name }],
      )
    ).rows[0].id;
    await db.query(
      "INSERT INTO notification_deliveries(school_id,outbox_id,parent_id,channel,status) VALUES($1,$2,$3,'EMAIL','SENT')",
      [f.schoolA, outbox, f.parentId],
    );
  }
  const r = await call(base(f.student) + '/notifications');
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body.data.map((n: any) => n.title)).toEqual(['First child alert']);
  const custom = await call('/notifications/messages', 'admin', 'post')
    .set('Idempotency-Key', crypto.randomUUID())
    .send({
      title: 'Family account update',
      body: 'A personal message',
      audience: 'MEMBERS',
      user_ids: [f.parent],
      roles: [],
    });
  expect(custom.status, JSON.stringify(custom.body)).toBe(202);
  expect(
    (await call(base(s.sibling) + '/notifications')).body.data.map((n: any) => n.title),
  ).toContain('Family account update');
  const ctx = { schoolId: f.schoolA, userId: f.parent };
  await expect(
    transaction(pools.api, ctx, (tx) =>
      tx.query("UPDATE parents SET full_name='Forged parent' WHERE id=$1", [f.parentId]),
    ),
  ).rejects.toThrow();
  const visible = await transaction(pools.api, ctx, (tx) => tx.query('SELECT id FROM students'));
  expect(visible.rows.map((r) => r.id).sort()).toEqual([f.student, s.sibling].sort());
});
it('shows every date with exact school-day totals, real absences, missing records, filters and unchanged correction records', async () => {
  await db.query(
    "INSERT INTO attendance_rule_versions(school_id,class_id,day_type,version_no,effective_from,effective_to,rules,created_by) VALUES($1,$2,'REGULAR',1,'2026-10-01','2026-10-08',$3,$4)",
    [f.schoolA, f.classId, { ...sampleRule, weekly_off: ['SAT', 'SUN'] }, f.admin],
  );
  for (const [date, status] of [
    ['2026-10-01', 'PRESENT'],
    ['2026-10-05', 'ABSENT'],
    ['2026-10-06', 'LATE'],
    ['2026-10-07', 'PENDING'],
  ])
    await db.query(
      'INSERT INTO daily_attendance(school_id,student_id,class_id,academic_session_id,attendance_date,attendance_status) VALUES($1,$2,$3,$4,$5,$6)',
      [f.schoolA, f.student, f.classId, f.session, date, status],
    );
  await db.query(
    "INSERT INTO school_holidays(school_id,label,on_date,ends_on,kind,target_class_ids) VALUES($1,'Section holiday','2026-10-02','2026-10-02','HOLIDAY',$2),($1,'Sunday school','2026-10-04','2026-10-04','WEEKEND_OVERRIDE',$2)",
    [f.schoolA, [f.classId]],
  );
  const range = '/attendance?from=2026-10-01&to=2026-10-07',
    r = await call(base(f.student) + range);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body.total).toBe(7);
  expect(r.body.summary).toMatchObject({
    school_days: 5,
    present_days: 2,
    absent_days: 1,
    late_days: 1,
    pending_days: 1,
    unrecorded_days: 1,
    finalized_days: 3,
    attendance_percentage: 66.7,
  });
  const map = Object.fromEntries(r.body.data.map((d: any) => [d.attendance_date, d]));
  expect(map['2026-10-02'].attendance_status).toBe('HOLIDAY');
  expect(map['2026-10-03'].attendance_status).toBe('WEEKLY_OFF');
  expect(map['2026-10-04']).toMatchObject({
    attendance_status: 'NOT_RECORDED',
    id: null,
    school_day: true,
  });
  const absent = await call(base(f.student) + range + '&status=ABSENT');
  expect(absent.body.data).toHaveLength(1);
  expect(absent.body.summary).toEqual(r.body.summary);
  const paged = await call(base(f.student) + range + '&page_size=2&page=2');
  expect(paged.body.total).toBe(7);
  expect(paged.body.data).toHaveLength(2);
  expect(paged.body.summary).toEqual(r.body.summary);
  const request = await call('/corrections', 'parent', 'post').send({
    daily_attendance_id: map['2026-10-05'].id,
    requested_status: 'PRESENT',
    reason: 'Please review this recorded absence.',
  });
  expect(request.status, JSON.stringify(request.body)).toBe(201);
  expect(
    (
      await db.query<{ attendance_status: string }>(
        'SELECT attendance_status FROM daily_attendance WHERE id=$1',
        [map['2026-10-05'].id],
      )
    ).rows[0].attendance_status,
  ).toBe('ABSENT');
  expect((await call(base(f.student) + '/attendance?from=2026-10-10&to=2026-10-01')).status).toBe(
    422,
  );
  expect((await call(base(f.student) + '/attendance?from=2020-01-01&to=2026-10-01')).status).toBe(
    422,
  );
  expect((await call(base(f.student) + '/attendance?from=2099-01-01&to=2099-01-02')).status).toBe(
    422,
  );
  expect((await call(base(f.student) + range + '&status=FORGED')).status).toBe(422);
  expect((await call(base(s.privateChild) + range)).status).toBe(404);
  await expect(
    transaction(pools.api, { schoolId: f.schoolA, userId: f.parent }, (tx) =>
      tx.query('SELECT * FROM app.parent_attendance_days($1,$2,$3)', [
        s.privateChild,
        '2026-10-01',
        '2026-10-07',
      ]),
    ),
  ).rejects.toThrow();
  // Past section holidays still apply after this child moves to another class.
  await db.query("UPDATE enrollments SET status='ENDED',ends_on='2026-10-07' WHERE student_id=$1", [
    f.student,
  ]);
  const moved = (
    await db.query<{ id: string }>(
      "INSERT INTO enrollments(school_id,student_id,class_id,academic_session_id,starts_on) VALUES($1,$2,$3,$4,'2026-10-08') RETURNING id",
      [f.schoolA, f.student, s.siblingClass, f.session],
    )
  ).rows[0].id;
  const historical = await call(base(f.student) + range);
  expect(historical.body.summary).toEqual(r.body.summary);
  expect(historical.body.data.find((d: any) => d.attendance_date === '2026-10-02').day_note).toBe(
    'Section holiday',
  );
  await db.query('DELETE FROM enrollments WHERE id=$1', [moved]);
  await db.query("UPDATE enrollments SET status='ACTIVE',ends_on=NULL WHERE student_id=$1", [
    f.student,
  ]);
});
it('uses configured school timing days when no versioned attendance rule applies', async () => {
  await db.query(
    "UPDATE schools SET settings=jsonb_set(settings,'{timetable}',$2::jsonb,true) WHERE id=$1",
    [f.schoolA, { ...defaultSchoolTimings, version: 1, days: [1, 2, 3, 4, 5] }],
  );
  const r = await call(base(f.student) + '/attendance?from=2026-10-10&to=2026-10-12');
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body.summary).toMatchObject({
    school_days: 1,
    unrecorded_days: 1,
    finalized_days: 0,
    attendance_percentage: null,
  });
  expect(r.body.uses_default_schedule).toBe(false);
  expect(r.body.data.find((d: any) => d.attendance_date === '2026-10-12')).toMatchObject({
    school_day: true,
    schedule_source: 'TIMETABLE',
  });
});
it('plots all published marks with normalized percentages and applies own-child exam, subject and date filters', async () => {
  const exam = (
    await db.query<{ id: string }>(
      "INSERT INTO exams(school_id,class_id,name,exam_type,max_score,status,assessment_kind,subject_id,starts_on) VALUES($1,$2,'Second exam','UNIT',50,'OPEN','SUBJECT_TEST',$3,'2026-10-05') RETURNING id",
      [f.schoolA, f.classId, f.subject],
    )
  ).rows[0].id;
  await db.query(
    'INSERT INTO marks(school_id,student_id,exam_id,subject_id,score,entered_by) VALUES($1,$2,$3,$4,25,$5)',
    [f.schoolA, f.student, exam, f.subject, f.admin],
  );
  await db.query("UPDATE exams SET status='PUBLISHED' WHERE id=$1", [exam]);
  const r = await call(base(f.student) + '/results/insights');
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body.summary).toMatchObject({
    score: 100,
    maximum: 150,
    percentage: 66.7,
    examinations: 2,
  });
  expect(r.body.subject_chart[0].percentage).toBe(66.7);
  expect(r.body.exam_chart.map((e: any) => e.percentage)).toEqual([50, 75]);
  const one = await call(base(f.student) + '/results/insights?exam_id=' + exam);
  expect(one.body.summary.percentage).toBe(50);
  expect(one.body.data).toHaveLength(1);
  expect(
    (await call(base(f.student) + '/results/insights?subject_id=' + f.subject)).body.data,
  ).toHaveLength(2);
  expect(
    (await call(base(f.student) + '/results/insights?exam_id=' + s.exams[s.privateChild])).body
      .data,
  ).toEqual([]);
  const dated = await call(base(f.student) + '/results/insights?from=2026-10-01&to=2026-10-06');
  expect(dated.body.data.map((r: any) => r.exam_id)).toEqual([exam]);
  await db.query("UPDATE exams SET status='OPEN' WHERE id=$1", [exam]);
  expect((await call(base(f.student) + '/results/insights')).body.summary.examinations).toBe(1);
  expect((await call(base(s.privateChild) + '/results/insights')).status).toBe(404);
  expect((await call(base(f.student) + '/results/insights?exam_id=forged')).status).toBe(422);
});
it('immediately revokes sibling access after unlinking while preserving the other child and single-child selector data', async () => {
  await db.query("UPDATE student_parents SET status='REVOKED' WHERE student_id=$1", [s.sibling]);
  expect((await call(base(s.sibling) + '/homework')).status).toBe(404);
  expect((await call('/parent/children')).body.children.map((c: any) => c.id)).toEqual([f.student]);
  expect((await call(base(f.student) + '/profile')).status).toBe(200);
});
