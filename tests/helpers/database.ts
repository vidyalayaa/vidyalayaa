import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { readFileSync, readdirSync } from 'node:fs';
import type pg from 'pg';
export async function portableDatabase() {
  const db = new PGlite({ extensions: { btree_gist, citext, pgcrypto } });
  await db.exec(
    "CREATE SCHEMA auth;CREATE SCHEMA storage;CREATE ROLE anon;CREATE ROLE authenticated;CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb DEFAULT '{}');CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
  );
  for (const file of readdirSync('db/migrations').sort())
    await db.exec(readFileSync(`db/migrations/${file}`, 'utf8'));
  return db;
}
// PGlite is real PostgreSQL compiled to WASM, with one backend. The mutex represents
// its one connection; multi-connection row-lock tests use the separate CI pg suite.
export function poolAdapters(db: PGlite) {
  let chain = Promise.resolve();
  async function lock() {
    let release!: () => void;
    const prior = chain;
    chain = new Promise((r) => (release = r));
    await prior;
    return release;
  }
  function pool(role: string) {
    return {
      async connect() {
        const unlock = await lock();
        return {
          async query(sql: string, args?: unknown[]) {
            if (sql === 'BEGIN' || sql === 'BEGIN READ ONLY') {
              await db.exec(`${sql};SET LOCAL ROLE ${role}`);
              return { rows: [], rowCount: 0 };
            }
            if (['COMMIT', 'ROLLBACK'].includes(sql)) {
              await db.exec(sql);
              return { rows: [], rowCount: 0 };
            }
            const r = await db.query(sql, args);
            return { ...r, rowCount: r.rows.length || r.affectedRows || 0 };
          },
          release: unlock,
        };
      },
      async query(sql: string, args?: unknown[]) {
        const unlock = await lock();
        try {
          await db.exec(`BEGIN;SET LOCAL ROLE ${role}`);
          const r = await db.query(sql, args);
          await db.exec('COMMIT');
          return { ...r, rowCount: r.rows.length || r.affectedRows || 0 };
        } catch (e) {
          await db.exec('ROLLBACK');
          throw e;
        } finally {
          unlock();
        }
      },
      async end() {},
    } as unknown as pg.Pool;
  }
  return {
    api: pool('app_api'),
    device: pool('app_device'),
    platform: pool('app_platform'),
    worker: pool('app_worker'),
  };
}
export async function fixture(db: Pick<PGlite, 'query'>) {
  const id = () => crypto.randomUUID(),
    schoolA = id(),
    schoolB = id(),
    admin = id(),
    teacher = id(),
    parent = id(),
    studentUser = id(),
    principal = id(),
    foreignStudent = id(),
    student = id(),
    classId = id(),
    subject = id(),
    session = id(),
    deviceA = id(),
    deviceB = id();
  await db.query(
    "INSERT INTO schools(id,school_code,name,status) VALUES($1,$3,'Test School A','ACTIVE'),($2,$4,'Test School B','ACTIVE')",
    [schoolA, schoolB, 'A' + schoolA.slice(0, 8), 'B' + schoolB.slice(0, 8)],
  );
  for (const [u, role] of [
    [admin, 'school_admin'],
    [teacher, 'teacher'],
    [parent, 'parent'],
    [studentUser, 'student'],
    [principal, 'principal'],
  ]) {
    await db.query('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3)', [
      u,
      `${u}@example.invalid`,
      JSON.stringify({ full_name: role + ' Test' }),
    ]);
    await db.query(
      "INSERT INTO school_memberships(school_id,user_id,role_id,status) SELECT $1,$2,id,'ACTIVE' FROM roles WHERE code=$3",
      [schoolA, u, role],
    );
  }
  await db.query(
    "INSERT INTO subscriptions(school_id,plan_id,status,current_period_end) SELECT $1,id,'ACTIVE',now()+interval '30 days' FROM subscription_plans WHERE code='PROFESSIONAL'",
    [schoolA],
  );
  await db.query(
    "INSERT INTO academic_sessions(id,school_id,name,starts_on,ends_on,is_current) VALUES($1,$2,'Test year','2026-01-01','2027-12-31',true)",
    [session, schoolA],
  );
  await db.query(
    "INSERT INTO classes(id,school_id,academic_session_id,grade,section) VALUES($1,$2,$3,'8','A')",
    [classId, schoolA, session],
  );
  await db.query("INSERT INTO subjects(id,school_id,code,name) VALUES($1,$2,'MAT','Mathematics')", [
    subject,
    schoolA,
  ]);
  await db.query(
    "INSERT INTO students(id,school_id,student_code,first_name,user_id) VALUES($1,$2,'STU001','Test learner',$3),($4,$5,'FOREIGN','Foreign learner',NULL)",
    [student, schoolA, studentUser, foreignStudent, schoolB],
  );
  await db.query(
    "INSERT INTO enrollments(school_id,student_id,class_id,academic_session_id,starts_on) VALUES($1,$2,$3,$4,'2026-01-01')",
    [schoolA, student, classId, session],
  );
  const teacherId = id(),
    parentId = id();
  await db.query(
    "INSERT INTO teachers(id,school_id,user_id,staff_code,full_name) VALUES($1,$2,$3,'T1','Teacher Test')",
    [teacherId, schoolA, teacher],
  );
  await db.query(
    "INSERT INTO teacher_class_assignments(school_id,teacher_id,class_id,subject_id,starts_on) VALUES($1,$2,$3,$4,'2026-01-01')",
    [schoolA, teacherId, classId, subject],
  );
  await db.query(
    "INSERT INTO parents(id,school_id,user_id,full_name,email) VALUES($1,$2,$3,'Parent Test','parent@example.invalid')",
    [parentId, schoolA, parent],
  );
  await db.query(
    "INSERT INTO student_parents(school_id,student_id,parent_id,relationship) VALUES($1,$2,$3,'GUARDIAN')",
    [schoolA, student, parentId],
  );
  const location = id();
  await db.query(
    "INSERT INTO device_locations(id,school_id,name,location_type) VALUES($1,$2,'Gate','ENTRY')",
    [location, schoolA],
  );
  for (const [d, code] of [
    [deviceA, 'DEV_A'],
    [deviceB, 'DEV_B'],
  ])
    await db.query(
      "INSERT INTO devices(id,school_id,device_code,name,location_id,status) VALUES($1,$2,$3,$3,$4,'ACTIVE')",
      [d, schoolA, code + schoolA.slice(0, 8), location],
    );
  await db.query(
    "INSERT INTO nfc_cards(school_id,student_id,card_uid,issued_by) VALUES($1,$2,'AABBCCDD',$3)",
    [schoolA, student, admin],
  );
  return {
    schoolA,
    schoolB,
    admin,
    teacher,
    parent,
    studentUser,
    principal,
    student,
    foreignStudent,
    classId,
    subject,
    session,
    deviceA,
    deviceB,
    parentId,
  };
}
