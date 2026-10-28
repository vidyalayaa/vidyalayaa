import type { PGlite } from '@electric-sql/pglite';
import type { fixture } from './database.js';
export async function studentProfileScenario(db: PGlite, f: Awaited<ReturnType<typeof fixture>>) {
  const other = crypto.randomUUID(),
    otherClass = crypto.randomUUID(),
    privateParent = crypto.randomUUID(),
    pastSession = crypto.randomUUID(),
    pastClass = crypto.randomUUID();
  await db.query(
    "UPDATE students SET first_name='Aarav',last_name='Sharma',date_of_birth='2012-02-29',gender='MALE',email='learner@example.invalid' WHERE id=$1",
    [f.student],
  );
  await db.query("UPDATE users SET phone='+91 90000 10000' WHERE id=$1", [f.studentUser]);
  await db.query("UPDATE enrollments SET roll_number='08-A-17' WHERE student_id=$1", [f.student]);
  await db.query("UPDATE parents SET phone='+91 90000 20000' WHERE id=$1", [f.parentId]);
  await db.query(
    "INSERT INTO classes(id,school_id,academic_session_id,grade,section) VALUES($1,$2,$3,'9','PRIVATE')",
    [otherClass, f.schoolA, f.session],
  );
  await db.query(
    "INSERT INTO students(id,school_id,student_code,first_name) VALUES($1,$2,'PRIVATE_PROFILE','Private learner')",
    [other, f.schoolA],
  );
  await db.query(
    "INSERT INTO enrollments(school_id,student_id,class_id,academic_session_id,starts_on) VALUES($1,$2,$3,$4,'2026-01-01')",
    [f.schoolA, other, otherClass, f.session],
  );
  await db.query(
    "INSERT INTO parents(id,school_id,full_name,email) VALUES($1,$2,'Private guardian','private@example.invalid')",
    [privateParent, f.schoolA],
  );
  await db.query("SELECT set_config('app.school_id',$1,false)", [f.schoolA]);
  await db.query(
    "INSERT INTO student_parents(school_id,student_id,parent_id,relationship) VALUES($1,$2,$3,'GUARDIAN'),($1,$2,$4,'OTHER')",
    [f.schoolA, other, privateParent, f.parentId],
  );
  await db.query("SELECT set_config('app.school_id','',false)");
  await db.query(
    "INSERT INTO academic_sessions(id,school_id,name,starts_on,ends_on) VALUES($1,$2,'Earlier session','2025-01-01','2025-12-31')",
    [pastSession, f.schoolA],
  );
  await db.query(
    "INSERT INTO classes(id,school_id,academic_session_id,grade,section) VALUES($1,$2,$3,'7','OLD')",
    [pastClass, f.schoolA, pastSession],
  );
  await db.query(
    "INSERT INTO enrollments(school_id,student_id,class_id,academic_session_id,roll_number,starts_on,ends_on,status) VALUES($1,$2,$3,$4,'OLD-17','2025-01-01','2025-12-31','ENDED')",
    [f.schoolA, f.student, pastClass, pastSession],
  );
  return { other, otherClass, privateParent, pastSession, pastClass };
}
