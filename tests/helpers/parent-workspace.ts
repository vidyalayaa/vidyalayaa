import type { PGlite } from '@electric-sql/pglite';
import type { fixture } from './database.js';

export async function parentScenario(db: PGlite, f: Awaited<ReturnType<typeof fixture>>) {
  const sibling = crypto.randomUUID(),
    privateChild = crypto.randomUUID(),
    siblingClass = crypto.randomUUID(),
    privateClass = crypto.randomUUID();
  await db.query("SELECT set_config('app.school_id',$1,false)", [f.schoolA]);
  // The worker-scoped browser fixture can follow enrollment-revocation checks.
  await db.query(
    "UPDATE enrollments SET status='ACTIVE',ends_on=NULL WHERE school_id=$1 AND student_id=$2",
    [f.schoolA, f.student],
  );
  await db.query(
    "UPDATE student_parents SET status='ACTIVE' WHERE school_id=$1 AND student_id=$2 AND parent_id=$3",
    [f.schoolA, f.student, f.parentId],
  );
  await db.query(
    "INSERT INTO classes(id,school_id,academic_session_id,grade,section) VALUES($1,$3,$4,'9','B'),($2,$3,$4,'10','C')",
    [siblingClass, privateClass, f.schoolA, f.session],
  );
  await db.query(
    "INSERT INTO teacher_class_assignments(school_id,class_id,subject_id,teacher_id,starts_on) VALUES($1,$2,$4,$5,'2026-01-01'),($1,$3,$4,$5,'2026-01-01')",
    [f.schoolA, siblingClass, privateClass, f.subject, f.teacherId],
  );
  await db.query('UPDATE classes SET class_teacher_id=$1 WHERE id=ANY($2::uuid[])', [
    f.teacherId,
    [siblingClass, privateClass],
  ]);
  await db.query(
    "INSERT INTO students(id,school_id,student_code,first_name,gender) VALUES($1,$3,'SIBLING','Linked sibling','FEMALE'),($2,$3,'PRIVATE','Other family learner','MALE')",
    [sibling, privateChild, f.schoolA],
  );
  await db.query(
    "INSERT INTO enrollments(school_id,student_id,class_id,academic_session_id,starts_on) VALUES($1,$2,$4,$6,'2026-01-01'),($1,$3,$5,$6,'2026-01-01')",
    [f.schoolA, sibling, privateChild, siblingClass, privateClass, f.session],
  );
  await db.query(
    "INSERT INTO student_parents(school_id,student_id,parent_id,relationship) VALUES($1,$2,$3,'GUARDIAN')",
    [f.schoolA, sibling, f.parentId],
  );
  const days: Record<string, string> = {},
    exams: Record<string, string> = {},
    homeworks: Record<string, string> = {};
  for (const [student, cid, name] of [
    [f.student, f.classId, 'First'],
    [sibling, siblingClass, 'Sibling'],
    [privateChild, privateClass, 'Private'],
  ]) {
    days[student] = (
      await db.query<{ id: string }>(
        "INSERT INTO daily_attendance(school_id,student_id,class_id,academic_session_id,attendance_date,attendance_status) VALUES($1,$2,$3,$4,current_date,'PRESENT') RETURNING id",
        [f.schoolA, student, cid, f.session],
      )
    ).rows[0].id;
    homeworks[student] = (
      await db.query<{ id: string }>(
        "INSERT INTO assignments(school_id,class_id,subject_id,kind,title,body,created_by) VALUES($1,$2,$3,'HOMEWORK',$4,'Homework details',$5) RETURNING id",
        [f.schoolA, cid, f.subject, name + ' homework', f.teacher],
      )
    ).rows[0].id;
    const exam = (
      await db.query<{ id: string }>(
        "INSERT INTO exams(school_id,class_id,name,exam_type,max_score,status,assessment_kind,subject_id) VALUES($1,$2,$3,'UNIT',100,'OPEN','SUBJECT_TEST',$4) RETURNING id",
        [f.schoolA, cid, name + ' exam', f.subject],
      )
    ).rows[0].id;
    await db.query(
      'INSERT INTO marks(school_id,exam_id,student_id,subject_id,score,entered_by) VALUES($1,$2,$3,$4,75,$5)',
      [f.schoolA, exam, student, f.subject, f.admin],
    );
    await db.query("UPDATE exams SET status='PUBLISHED' WHERE id=$1", [exam]);
    exams[student] = exam;
    await db.query(
      "INSERT INTO fee_records(school_id,student_id,academic_session_id,fee_type,amount_due,due_on,status) VALUES($1,$2,$3,$4,500,current_date,'UNPAID')",
      [f.schoolA, student, f.session, name + ' tuition'],
    );
    await db.query(
      "INSERT INTO announcements(school_id,class_id,title,body,audience,published_at,created_by) VALUES($1,$2,$3,'Class notice','CLASS',now(),$4)",
      [f.schoolA, cid, name + ' announcement', f.admin],
    );
    await db.query(
      "INSERT INTO school_holidays(school_id,label,on_date,ends_on,kind,target_class_ids) VALUES($1,$2,current_date,current_date+2,'ACTIVITY',$3)",
      [f.schoolA, name + ' event', [cid]],
    );
  }
  await db.query(
    "INSERT INTO announcements(school_id,title,body,audience,published_at,created_by) VALUES($1,'School-wide announcement','All families','SCHOOL',now(),$2),($1,'Staff private announcement','Staff only','STAFF',now(),$2)",
    [f.schoolA, f.admin],
  );
  await db.query("SELECT set_config('app.school_id','',false)");
  return { sibling, privateChild, siblingClass, privateClass, days, exams, homeworks };
}
