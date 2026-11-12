import { afterAll, beforeAll, expect, test } from 'vitest';
import type { Actor } from '../../apps/api/src/middleware/auth';
import { transaction } from '../../apps/api/src/lib/db';
import { readAttendanceCalendar } from '../../apps/api/src/modules/school/attendance-calendar';
import { fixture, poolAdapters, portableDatabase } from '../helpers/database';

let db: Awaited<ReturnType<typeof portableDatabase>>;
let records: Awaited<ReturnType<typeof fixture>>;
const other = crypto.randomUUID();
const oldClass = crypto.randomUUID();
const oldSession = crypto.randomUUID();

beforeAll(async () => {
  db = await portableDatabase();
  records = await fixture(db);
  const { schoolA, student, classId, session } = records;
  await db.query(
    "INSERT INTO students(id,school_id,student_code,first_name) VALUES($1,$2,'SECOND','Second learner')",
    [other, schoolA],
  );
  await db.query(
    "INSERT INTO enrollments(school_id,student_id,class_id,academic_session_id,starts_on) VALUES($1,$2,$3,$4,'2026-01-01')",
    [schoolA, other, classId, session],
  );
  await db.query(
    `INSERT INTO daily_attendance(school_id,student_id,class_id,academic_session_id,attendance_date,attendance_status)
     VALUES($1,$2,$4,$5,'2026-10-01','PRESENT'),($1,$3,$4,$5,'2026-10-01','ABSENT'),
       ($1,$2,$4,$5,'2026-10-02','PRESENT'),($1,$2,$4,$5,'2026-10-03','HALF_DAY'),
       ($1,$2,$4,$5,'2026-10-05','ABSENT')`,
    [schoolA, student, other, classId, session],
  );
  await db.query(
    `INSERT INTO school_holidays(school_id,label,on_date,kind,target_class_ids)
     VALUES($1,'Section holiday','2026-10-02','HOLIDAY',$2),
       ($1,'Working Sunday','2026-10-04','WEEKEND_OVERRIDE',$2)`,
    [schoolA, [classId]],
  );
  await db.query(
    "INSERT INTO academic_sessions(id,school_id,name,starts_on,ends_on) VALUES($1,$2,'Historical year','2025-01-01','2025-12-31')",
    [oldSession, schoolA],
  );
  await db.query(
    "INSERT INTO classes(id,school_id,academic_session_id,grade,section) VALUES($1,$2,$3,'7','B')",
    [oldClass, schoolA, oldSession],
  );
  await db.query(
    "INSERT INTO enrollments(school_id,student_id,class_id,academic_session_id,starts_on,ends_on,status) VALUES($1,$2,$3,$4,'2025-01-01','2025-12-31','ENDED')",
    [schoolA, student, oldClass, oldSession],
  );
  await db.query(
    "INSERT INTO school_holidays(school_id,label,on_date,kind,target_class_ids) VALUES($1,'Historical section holiday','2025-10-02','HOLIDAY',$2)",
    [schoolA, [oldClass]],
  );
});
afterAll(async () => {
  await db?.close();
});

function read(
  role: 'school_admin' | 'principal' | 'teacher' | 'student' | 'parent',
  from: string,
  to: string,
  academicSession?: string,
) {
  const family = role === 'parent' || role === 'student';
  const id = {
    school_admin: records.admin,
    principal: records.principal,
    teacher: records.teacher,
    student: records.studentUser,
    parent: records.parent,
  }[role];
  const context = {
    schoolId: records.schoolA,
    userId: id,
    parentChildId: role === 'parent' ? records.student : undefined,
  };
  const actor = { id, context, active: { role } } as Actor;
  return transaction(
    poolAdapters(db).api,
    context,
    (tx) =>
      readAttendanceCalendar(
        tx,
        actor,
        { school: records.schoolA, family, student: family ? records.student : undefined },
        { academic_session_id: academicSession },
        from,
        to,
        '2026-10-04',
      ),
    true,
  );
}

test('summarizes scoped working days, holiday records, half days, overrides and future dates', async () => {
  for (const role of ['school_admin', 'principal', 'teacher'] as const) {
    const days = await read(role, '2026-10-01', '2026-10-06', records.session);
    expect(days).toMatchObject([
      { date: '2026-10-01', working: 2, present: 1, absent: 1 },
      {
        date: '2026-10-02',
        working: 0,
        present: 0,
        holidays: 2,
        holiday_names: ['Section holiday'],
      },
      { date: '2026-10-03', working: 2, half_day: 1, unmarked: 1 },
      { date: '2026-10-04', working: 2, unmarked: 2, weekly_off: 0 },
    ]);
  }
});

test('family views include historical section holidays and only their own attendance', async () => {
  for (const role of ['student', 'parent'] as const) {
    const [personal] = await read(role, '2026-10-01', '2026-10-01');
    expect(personal).toMatchObject({ working: 1, present: 1, absent: 0 });
    const days = await read(role, '2025-10-01', '2025-10-02', oldSession);
    expect(days).toMatchObject([
      { date: '2025-10-01', working: 1, unmarked: 1 },
      {
        date: '2025-10-02',
        working: 0,
        holidays: 1,
        holiday_names: ['Historical section holiday'],
      },
    ]);
  }
});

test('database denies other students and unlinked child calendar lookups', async () => {
  const { schoolA, studentUser, parent } = records;
  const pool = poolAdapters(db).api;
  const result = await transaction(
    pool,
    { schoolId: schoolA, userId: studentUser },
    (tx) => tx.query('SELECT DISTINCT student_id FROM daily_attendance ORDER BY student_id'),
    true,
  );
  expect(result.rows).toEqual([{ student_id: records.student }]);
  for (const userId of [studentUser, parent]) {
    await expect(
      transaction(
        pool,
        { schoolId: schoolA, userId },
        (tx) =>
          tx.query(
            "SELECT * FROM app.attendance_calendar_holidays($1,$2,'2026-10-01','2026-10-07')",
            [schoolA, other],
          ),
        true,
      ),
    ).rejects.toMatchObject({ code: '42501' });
  }
});
