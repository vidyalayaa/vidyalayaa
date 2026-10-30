import type { PGlite } from '@electric-sql/pglite';
import type { fixture } from './database.js';

export async function studentLearningScenario(db: PGlite, f: Awaited<ReturnType<typeof fixture>>) {
  const otherStudent = crypto.randomUUID(),
    otherClass = crypto.randomUUID(),
    privateSubject = crypto.randomUUID(),
    pastSession = crypto.randomUUID(),
    pastClass = crypto.randomUUID(),
    pastSubject = crypto.randomUUID();
  await db.query(
    "INSERT INTO students(id,school_id,student_code,first_name) VALUES($1,$2,'OTHER_MARKS','Other learner')",
    [otherStudent, f.schoolA],
  );
  await db.query(
    "INSERT INTO classes(id,school_id,academic_session_id,grade,section) VALUES($1,$2,$3,'9','PRIVATE')",
    [otherClass, f.schoolA, f.session],
  );
  await db.query(
    "INSERT INTO enrollments(school_id,student_id,class_id,academic_session_id,starts_on) VALUES($1,$2,$3,$4,'2026-01-01')",
    [f.schoolA, otherStudent, otherClass, f.session],
  );
  await db.query(
    "INSERT INTO subjects(id,school_id,code,name) VALUES($1,$2,'PRIVATE_SUB','Private subject'),($3,$2,'PAST_SUB','Earlier subject')",
    [privateSubject, f.schoolA, pastSubject],
  );
  await db.query(
    "INSERT INTO teacher_class_assignments(school_id,class_id,subject_id,teacher_id,starts_on) VALUES($1,$2,$3,$4,'2026-01-01')",
    [f.schoolA, otherClass, privateSubject, f.teacherId],
  );
  await db.query(
    "INSERT INTO academic_sessions(id,school_id,name,starts_on,ends_on) VALUES($1,$2,'Earlier learning year','2025-01-01','2025-12-31')",
    [pastSession, f.schoolA],
  );
  await db.query(
    "INSERT INTO classes(id,school_id,academic_session_id,grade,section) VALUES($1,$2,$3,'7','OLD')",
    [pastClass, f.schoolA, pastSession],
  );
  await db.query(
    "INSERT INTO enrollments(school_id,student_id,class_id,academic_session_id,starts_on,ends_on,status) VALUES($1,$2,$3,$4,'2025-01-01','2025-12-31','ENDED')",
    [f.schoolA, f.student, pastClass, pastSession],
  );
  await db.query(
    "INSERT INTO teacher_class_assignments(school_id,class_id,subject_id,teacher_id,starts_on,ends_on) VALUES($1,$2,$3,$4,'2025-01-01','2025-12-31')",
    [f.schoolA, pastClass, pastSubject, f.teacherId],
  );
  const ids: Record<string, string> = {};
  for (const [name, classroom, subject, student, score, status] of [
    ['Current assessment', f.classId, f.subject, f.student, 91, 'OPEN'],
    ['Zero score assessment', f.classId, f.subject, f.student, 0, 'PUBLISHED'],
    ['Locked assessment', f.classId, f.subject, f.student, 52, 'LOCKED'],
    ['Private assessment', otherClass, privateSubject, otherStudent, 97, 'PUBLISHED'],
    ['Earlier published assessment', pastClass, pastSubject, f.student, 65, 'PUBLISHED'],
  ] as const) {
    const id = crypto.randomUUID();
    ids[name] = id;
    await db.query(
      "INSERT INTO exams(id,school_id,class_id,name,exam_type,max_score,status,assessment_kind,subject_id) VALUES($1,$2,$3,$4,'UNIT',100,'OPEN','SUBJECT_TEST',$5)",
      [id, f.schoolA, classroom, name, subject],
    );
    await db.query(
      'INSERT INTO marks(school_id,exam_id,student_id,subject_id,score,entered_by) VALUES($1,$2,$3,$4,$5,$6)',
      [f.schoolA, id, student, subject, score, f.admin],
    );
    await db.query('UPDATE exams SET status=$2 WHERE id=$1', [id, status]);
  }
  // Another student's mark in the same class/exam must never become visible.
  await db.query(
    'INSERT INTO marks(school_id,exam_id,student_id,subject_id,score,entered_by) VALUES($1,$2,$3,$4,99,$5)',
    [f.schoolA, ids['Current assessment'], otherStudent, f.subject, f.admin],
  );
  return { ids, otherStudent, otherClass, privateSubject, pastClass, pastSubject };
}
