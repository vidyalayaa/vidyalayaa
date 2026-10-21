import { beforeAll, afterAll, it, expect } from 'vitest';
import request from 'supertest';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { portableDatabase, poolAdapters, fixture } from '../helpers/database.js';
import { createApp } from '../../apps/api/src/app.js';
import { transaction } from '../../apps/api/src/lib/db.js';
import type { Config } from '../../apps/api/src/lib/config.js';
import { generateReports } from '../../apps/worker/src/reports.js';
let db: PGlite,
  f: Awaited<ReturnType<typeof fixture>>,
  pools: ReturnType<typeof poolAdapters>,
  app: ReturnType<typeof createApp>;
let otherSubject: string,
  otherClass: string,
  hiddenClass: string,
  hiddenStudent: string,
  otherStudent: string,
  classTeacher: string,
  teacherRecord: string,
  classTeacherRecord: string,
  official: string,
  subjectTest: string;
beforeAll(async () => {
  db = await portableDatabase();
  f = await fixture(db);
  pools = poolAdapters(db);
  teacherRecord = (
    await db.query<{ id: string }>('SELECT id FROM teachers WHERE user_id=$1', [f.teacher])
  ).rows[0].id;
  classTeacher = crypto.randomUUID();
  classTeacherRecord = crypto.randomUUID();
  await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [
    classTeacher,
    'class-teacher@example.invalid',
  ]);
  await db.query(
    "INSERT INTO school_memberships(school_id,user_id,role_id,status) SELECT $1,$2,id,'ACTIVE' FROM roles WHERE code='teacher'",
    [f.schoolA, classTeacher],
  );
  await db.query(
    "INSERT INTO teachers(id,school_id,user_id,staff_code,full_name) VALUES($1,$2,$3,'CLASS_TEACHER','Designated class teacher')",
    [classTeacherRecord, f.schoolA, classTeacher],
  );
  otherSubject = (
    await db.query<{ id: string }>(
      "INSERT INTO subjects(school_id,code,name) VALUES($1,'ENG','English') RETURNING id",
      [f.schoolA],
    )
  ).rows[0].id;
  otherClass = (
    await db.query<{ id: string }>(
      "INSERT INTO classes(school_id,academic_session_id,grade,section) VALUES($1,$2,'9','B') RETURNING id",
      [f.schoolA, f.session],
    )
  ).rows[0].id;
  hiddenClass = (
    await db.query<{ id: string }>(
      "INSERT INTO classes(school_id,academic_session_id,grade,section) VALUES($1,$2,'10','C') RETURNING id",
      [f.schoolA, f.session],
    )
  ).rows[0].id;
  otherStudent = (
    await db.query<{ id: string }>(
      "INSERT INTO students(school_id,student_code,first_name) VALUES($1,'CLASS_B','Other assigned learner') RETURNING id",
      [f.schoolA],
    )
  ).rows[0].id;
  hiddenStudent = (
    await db.query<{ id: string }>(
      "INSERT INTO students(school_id,student_code,first_name) VALUES($1,'HIDDEN','Unassigned learner') RETURNING id",
      [f.schoolA],
    )
  ).rows[0].id;
  const hiddenParent = (
    await db.query<{ id: string }>(
      "INSERT INTO parents(school_id,full_name) VALUES($1,'Unassigned guardian') RETURNING id",
      [f.schoolA],
    )
  ).rows[0].id;
  await db.query(
    "INSERT INTO student_parents(school_id,student_id,parent_id,relationship) VALUES($1,$2,$3,'GUARDIAN')",
    [f.schoolA, hiddenStudent, hiddenParent],
  );
  await db.query("INSERT INTO parents(school_id,full_name) VALUES($1,'Unlinked guardian')", [
    f.schoolA,
  ]);
  for (const [student, cid] of [
    [otherStudent, otherClass],
    [hiddenStudent, hiddenClass],
  ])
    await db.query(
      "INSERT INTO enrollments(school_id,student_id,class_id,academic_session_id,starts_on) VALUES($1,$2,$3,$4,'2026-01-01')",
      [f.schoolA, student, cid, f.session],
    );
  for (const [teacher, cid, sub] of [
    [teacherRecord, otherClass, otherSubject],
    [classTeacherRecord, f.classId, otherSubject],
  ])
    await db.query(
      "INSERT INTO teacher_class_assignments(school_id,teacher_id,class_id,subject_id,starts_on) VALUES($1,$2,$3,$4,'2026-01-01')",
      [f.schoolA, teacher, cid, sub],
    );
  await db.exec(`SELECT set_config('app.school_id','${f.schoolA}',false)`);
  await db.query('UPDATE classes SET class_teacher_id=$2 WHERE id=$1', [
    f.classId,
    classTeacherRecord,
  ]);
  await db.query('UPDATE classes SET class_teacher_id=$2 WHERE id=$1', [otherClass, teacherRecord]);
  official = (
    await db.query<{ id: string }>(
      "INSERT INTO exams(school_id,class_id,name,exam_type,max_score,status) VALUES($1,$2,'Official final','FINAL',100,'OPEN') RETURNING id",
      [f.schoolA, f.classId],
    )
  ).rows[0].id;
  const auth = {
    auth: {
      getUser: async (token: string) => ({
        data: {
          user: {
            id: (
              {
                teacher: f.teacher,
                admin: f.admin,
                principal: f.principal,
                ct: classTeacher,
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
    { ...pools, supabase: auth },
  );
});
afterAll(async () => db.close());
function call(method: 'get' | 'post' | 'patch', path: string, role = 'teacher') {
  return request(app)
    [method]('/api/v1' + path)
    .set('Authorization', 'Bearer ' + role)
    .set('X-School-Id', f.schoolA);
}

it('exposes multiple assigned classes and subjects but no academic administration or unassigned learners', async () => {
  const classes = await call('get', '/teaching/classes');
  expect(classes.status).toBe(200);
  expect(classes.body.data).toHaveLength(2);
  expect(classes.body.data.find((c: any) => c.id === otherClass)).toMatchObject({
    is_class_teacher: true,
    subjects: [{ id: otherSubject, name: 'English', code: 'ENG' }],
  });
  expect((await call('get', '/resources/academic_sessions')).status).toBe(403);
  expect(
    (await call('get', '/resources/students?class_id=' + f.classId)).body.data.map(
      (s: any) => s.id,
    ),
  ).toEqual([f.student]);
  expect((await call('get', '/resources/students?class_id=' + hiddenClass)).status).toBe(404);
  expect((await call('get', '/students/' + hiddenStudent + '/overview')).status).toBe(404);
  expect(
    (await call('get', '/resources/parents?class_id=' + f.classId)).body.data.map((p: any) => p.id),
  ).toEqual([f.parentId]);
});
it('requires one active Class Teacher for each saved class and specific subject assignments', async () => {
  expect(
    (
      await call('post', '/resources/classes', 'admin').send({
        academic_session_id: f.session,
        grade: '11',
        section: 'A',
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await call('patch', '/resources/classes/' + f.classId, 'admin').send({
        class_teacher_id: null,
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await call('patch', '/resources/classes/' + hiddenClass, 'admin').send({
        class_teacher_id: teacherRecord,
      })
    ).status,
  ).toBe(200);
  await call('patch', '/resources/classes/' + hiddenClass, 'admin').send({
    class_teacher_id: classTeacherRecord,
  });
  expect(
    (
      await call('patch', '/resources/classes/' + f.classId, 'admin').send({
        class_teacher_id: teacherRecord,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call('patch', '/resources/classes/' + f.classId, 'admin').send({
        class_teacher_id: classTeacherRecord,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call('post', '/resources/teacher_class_assignments', 'admin').send({
        teacher_id: teacherRecord,
        class_id: hiddenClass,
        starts_on: '2026-01-01',
      })
    ).status,
  ).toBe(422);
});
it('limits homework and attendance to assigned classes and exact subjects', async () => {
  for (const [sub, cid, status] of [
    [f.subject, f.classId, 201],
    [otherSubject, f.classId, 404],
    [f.subject, hiddenClass, 404],
  ] as const)
    expect(
      (
        await call('post', '/resources/assignments').send({
          class_id: cid,
          subject_id: sub,
          kind: 'HOMEWORK',
          title: 'Scoped homework',
        })
      ).status,
    ).toBe(status);
  expect(
    (
      await call('post', '/attendance/manual').send({
        student_id: hiddenStudent,
        date: '2026-10-21',
        status: 'PRESENT',
        reason: 'Unassigned attendance rejected',
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await call('post', '/attendance/manual').send({
        student_id: f.student,
        date: '2026-10-21',
        status: 'PRESENT',
        reason: 'Assigned attendance accepted',
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await call('post', '/attendance/manual', 'ct').send({
        student_id: f.student,
        date: '2026-10-21',
        status: 'PRESENT',
        reason: 'Class Teacher attendance',
      })
    ).status,
  ).toBe(200);
  expect(
    (await call('get', '/attendance?class_id=' + f.classId + '&date=2026-10-21')).body.data.map(
      (r: any) => r.student_id,
    ),
  ).toContain(f.student);
  expect(
    (
      await call('post', '/attendance/bulk').send({
        class_id: f.classId,
        date: '2026-10-21',
        reason: 'Subject teacher bulk rejected',
        records: [{ student_id: f.student, status: 'ABSENT', expected_version: 1 }],
      })
    ).status,
  ).toBe(403);
});
it('allows teachers to create subject tests and enter only the test subject', async () => {
  const created = await call('post', '/resources/exams').send({
    class_id: f.classId,
    subject_id: f.subject,
    assessment_kind: 'SUBJECT_TEST',
    name: 'Teacher mathematics test',
    exam_type: 'UNIT',
    max_score: 20,
    status: 'OPEN',
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  subjectTest = created.body.id;
  expect(
    (
      await call('post', '/resources/marks').send({
        exam_id: subjectTest,
        student_id: f.student,
        subject_id: f.subject,
        score: 18,
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await call('post', '/resources/marks').send({
        exam_id: subjectTest,
        student_id: f.student,
        subject_id: otherSubject,
        score: 18,
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await call('post', '/resources/exams').send({
        class_id: f.classId,
        subject_id: otherSubject,
        assessment_kind: 'SUBJECT_TEST',
        name: 'Forbidden test',
        exam_type: 'UNIT',
        max_score: 20,
        status: 'OPEN',
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await call('post', '/resources/exams').send({
        class_id: f.classId,
        name: 'Forbidden official',
        exam_type: 'FINAL',
        max_score: 100,
        status: 'OPEN',
      })
    ).status,
  ).toBe(403);
});
it('reserves official individual and CSV marks for the designated Class Teacher across subjects', async () => {
  const body = { exam_id: official, student_id: f.student, subject_id: f.subject, score: 90 };
  expect((await call('post', '/resources/marks').send(body)).status).toBe(404);
  expect(
    (
      await call('post', '/marks/bulk').send({
        exam_id: official,
        entries: [{ student_id: f.student, subject_id: f.subject, score: 90 }],
      })
    ).status,
  ).toBe(404);
  const allowed = await call('post', '/resources/marks', 'ct').send(body);
  expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);
  const { exam_id, ...entry } = body;
  expect(
    (await call('post', '/marks/bulk', 'ct').send({ exam_id, entries: [{ ...entry, score: 91 }] }))
      .status,
  ).toBe(200);
  expect((await call('get', '/resources/exams?assessment_kind=OFFICIAL')).body.total).toBe(0);
  expect((await call('get', '/resources/exams?assessment_kind=OFFICIAL', 'ct')).body.total).toBe(1);
  expect(
    (await call('patch', '/resources/exams/' + official, 'ct').send({ status: 'PUBLISHED' }))
      .status,
  ).toBe(403);
});
it('immediately revokes official mark access after Class Teacher replacement', async () => {
  const key = crypto.randomUUID();
  const attendance = {
    student_id: f.student,
    date: '2026-10-21',
    status: 'PRESENT',
    reason: 'Class Teacher retry authorization',
  };
  expect(
    (await call('post', '/attendance/manual', 'ct').set('Idempotency-Key', key).send(attendance))
      .status,
  ).toBe(200);
  expect(
    (
      await call('patch', '/resources/classes/' + f.classId, 'admin').send({
        class_teacher_id: teacherRecord,
      })
    ).status,
  ).toBe(200);
  expect((await call('get', '/resources/exams/' + official, 'ct')).status).toBe(404);
  expect(
    (await call('post', '/attendance/manual', 'ct').set('Idempotency-Key', key).send(attendance))
      .status,
  ).toBe(403);
  expect((await call('get', '/resources/exams/' + official)).status).toBe(200);
  expect(
    (
      await call('patch', '/resources/classes/' + f.classId, 'admin').send({
        class_teacher_id: classTeacherRecord,
      })
    ).status,
  ).toBe(200);
});
it('enforces teacher restrictions in direct SQL under the real non-bypass API role', async () => {
  const ctx = { schoolId: f.schoolA, userId: f.teacher, actorType: 'USER' as const };
  const rows = await transaction(pools.api, ctx, async (tx) => ({
    students: (await tx.query('SELECT id FROM students')).rows,
    parents: (await tx.query('SELECT id FROM parents')).rows,
    exams: (await tx.query('SELECT id FROM exams')).rows,
  }));
  expect(rows.students.map((r) => r.id)).not.toContain(hiddenStudent);
  expect(rows.parents.map((r) => r.id)).toEqual([f.parentId]);
  expect(rows.exams.map((r) => r.id)).not.toContain(official);
  await expect(
    transaction(pools.api, ctx, (tx) =>
      tx.query("UPDATE daily_attendance SET attendance_status='ABSENT' WHERE student_id=$1", [
        f.student,
      ]),
    ),
  ).rejects.toThrow(/CLASS_TEACHER_REQUIRED|row-level security/);
  const day = (
    await db.query<{ id: string }>('SELECT id FROM daily_attendance WHERE student_id=$1', [
      f.student,
    ])
  ).rows[0];
  expect(
    (
      await call('post', '/corrections').send({
        daily_attendance_id: day.id,
        requested_status: 'ABSENT',
        reason: 'Subject teacher cannot request changes',
      })
    ).status,
  ).toBe(403);
  await expect(
    transaction(pools.api, ctx, (tx) =>
      tx.query(
        "INSERT INTO attendance_corrections(school_id,daily_attendance_id,requested_status,reason,requested_by) VALUES($1,$2,'ABSENT','SQL subject teacher change',$3)",
        [f.schoolA, day.id, f.teacher],
      ),
    ),
  ).rejects.toThrow(/row-level security/);
  await expect(
    transaction(pools.api, ctx, (tx) =>
      tx.query("UPDATE classes SET section='HACK' WHERE id=$1", [f.classId]),
    ),
  ).rejects.toThrow();
  await expect(
    transaction(pools.api, ctx, (tx) =>
      tx.query(
        'INSERT INTO marks(school_id,exam_id,student_id,subject_id,score,entered_by) VALUES($1,$2,$3,$4,70,$5)',
        [f.schoolA, official, f.student, f.subject, f.teacher],
      ),
    ),
  ).rejects.toThrow();
  await expect(
    transaction(pools.api, ctx, (tx) =>
      tx.query(
        "INSERT INTO assignments(school_id,class_id,subject_id,kind,title,created_by) VALUES($1,$2,$3,'HOMEWORK','SQL bypass attempt',$4)",
        [f.schoolA, hiddenClass, f.subject, f.teacher],
      ),
    ),
  ).rejects.toThrow();
  await expect(
    transaction(pools.api, ctx, (tx) =>
      tx.query('UPDATE marks SET score=99 WHERE exam_id=$1', [subjectTest]),
    ),
  ).rejects.toThrow(/TEACHER_MARK_ACCESS_DENIED/);
  await expect(
    transaction(pools.api, ctx, (tx) =>
      tx.query('DELETE FROM teacher_class_assignments RETURNING id'),
    ),
  ).rejects.toThrow(/permission denied/);
});

it('exports teacher subject-test results without official marks from another Class Teacher workflow', async () => {
  const report = await call('post', '/reports').send({
    kind: 'ACADEMIC',
    format: 'CSV',
    from: '2026-01-01',
    to: '2027-12-31',
  });
  expect(report.status).toBe(202);
  const objects = new Map<string, Buffer>();
  const storage = {
    storage: {
      from: () => ({
        upload: async (path: string, body: Blob | Buffer) => {
          objects.set(
            path,
            body instanceof Blob ? Buffer.from(await body.arrayBuffer()) : Buffer.from(body),
          );
          return { error: null };
        },
      }),
    },
  } as unknown as SupabaseClient;
  await generateReports(pools.worker, f.schoolA, storage);
  const row = (
    await db.query<{ status: string; storage_path: string; error_code: string }>(
      'SELECT status,storage_path,error_code FROM report_documents WHERE id=$1',
      [report.body.id],
    )
  ).rows[0];
  expect(row.status, row.error_code).toBe('COMPLETED');
  const csv = objects.get(row.storage_path)!.toString();
  expect(csv).toContain('Teacher mathematics test');
  expect(csv).not.toContain('Official final');
  expect(csv).not.toContain('Unassigned learner');
});

it('rolls back an entire teacher marks upload when one subject is unauthorized', async () => {
  const result = await call('post', '/marks/bulk').send({
    exam_id: subjectTest,
    entries: [
      { student_id: f.student, subject_id: f.subject, score: 19 },
      { student_id: f.student, subject_id: otherSubject, score: 19 },
    ],
  });
  expect(result.status).toBe(403);
  expect(
    Number(
      (
        await db.query<{ score: string }>(
          'SELECT score FROM marks WHERE exam_id=$1 AND subject_id=$2',
          [subjectTest, f.subject],
        )
      ).rows[0].score,
    ),
  ).toBe(18);
});

it('supports a Class Teacher without subject assignments but grants no homework subject access', async () => {
  const created = await call('post', '/resources/classes', 'admin').send({
    academic_session_id: f.session,
    grade: '11',
    section: 'CT_ONLY',
    class_teacher_id: teacherRecord,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const cid = created.body.id;
  const student = (
    await db.query<{ id: string }>(
      "INSERT INTO students(school_id,student_code,first_name) VALUES($1,'CT_ONLY','Class Teacher only learner') RETURNING id",
      [f.schoolA],
    )
  ).rows[0].id;
  await db.query(
    "INSERT INTO enrollments(school_id,student_id,class_id,academic_session_id,starts_on) VALUES($1,$2,$3,$4,'2026-01-01')",
    [f.schoolA, student, cid, f.session],
  );
  expect(
    (await call('get', '/teaching/classes')).body.data.find((c: any) => c.id === cid),
  ).toMatchObject({ is_class_teacher: true, subjects: [] });
  expect(
    (
      await call('post', '/attendance/manual').send({
        student_id: student,
        date: '2026-10-21',
        status: 'PRESENT',
        reason: 'Designated class attendance',
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call('post', '/resources/assignments').send({
        class_id: cid,
        subject_id: f.subject,
        kind: 'HOMEWORK',
        title: 'No teaching subject assigned',
      })
    ).status,
  ).toBe(404);
  const exam = await call('post', '/resources/exams', 'admin').send({
    class_id: cid,
    name: 'Class Teacher official examination',
    exam_type: 'FINAL',
    max_score: 100,
    status: 'OPEN',
  });
  expect(exam.status).toBe(201);
  expect(
    (
      await call('post', '/marks/bulk').send({
        exam_id: exam.body.id,
        entries: [{ student_id: student, subject_id: f.subject, score: 95 }],
      })
    ).status,
  ).toBe(200);
  await expect(
    transaction(pools.api, { schoolId: f.schoolA, userId: f.admin }, (tx) =>
      tx.query('UPDATE classes SET class_teacher_id=NULL WHERE id=$1', [cid]),
    ),
  ).rejects.toThrow(/CLASS_TEACHER_REQUIRED/);
});

it('fails closed in SQL and HTTP when a teacher membership is suspended', async () => {
  await db.query(
    "UPDATE school_memberships SET status='SUSPENDED' WHERE school_id=$1 AND user_id=$2",
    [f.schoolA, f.teacher],
  );
  try {
    expect((await call('get', '/teaching/classes')).status).toBe(404);
    const ctx = { schoolId: f.schoolA, userId: f.teacher, actorType: 'USER' as const };
    await transaction(pools.api, ctx, async (tx) => {
      for (const table of [
        'students',
        'parents',
        'classes',
        'teachers',
        'teacher_class_assignments',
        'assignments',
        'exams',
        'marks',
        'school_holidays',
      ]) {
        expect((await tx.query(`SELECT id FROM ${table}`)).rows, table).toEqual([]);
      }
    });
  } finally {
    await db.query(
      "UPDATE school_memberships SET status='ACTIVE' WHERE school_id=$1 AND user_id=$2",
      [f.schoolA, f.teacher],
    );
  }
});
