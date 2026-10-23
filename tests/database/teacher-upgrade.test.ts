import { providerSessionSchema } from '../helpers/provider-sessions.js';
import { it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { readFile, readdir } from 'node:fs/promises';
import { fixture } from '../helpers/database.js';
it('preserves legacy exams, marks, and null-subject assignments without granting wildcard teacher access', async () => {
  const db = new PGlite({ extensions: { btree_gist, pgcrypto, citext } });
  try {
    await db.exec(
      "CREATE SCHEMA auth;CREATE SCHEMA storage;CREATE ROLE anon;CREATE ROLE authenticated;CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb DEFAULT '{}');CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
    );
    const files = (await readdir('db/migrations'))
      .sort()
      .filter((file) => file <= '20261021154148_teacher_subject_authorization.sql');
    await db.exec(providerSessionSchema);
    for (const file of files.slice(0, -1))
      await db.exec(await readFile('db/migrations/' + file, 'utf8'));
    const f = await fixture(db);
    await db.query('UPDATE classes SET class_teacher_id=NULL WHERE id=$1', [f.classId]);
    await db.query('UPDATE teacher_class_assignments SET subject_id=NULL WHERE school_id=$1', [
      f.schoolA,
    ]);
    const exam = (
      await db.query<{ id: string }>(
        "INSERT INTO exams(school_id,class_id,name,exam_type,max_score,status) VALUES($1,$2,'Legacy official marks','UNIT',100,'OPEN') RETURNING id",
        [f.schoolA, f.classId],
      )
    ).rows[0].id;
    const mark = (
      await db.query<{ id: string }>(
        'INSERT INTO marks(school_id,exam_id,student_id,subject_id,score,entered_by) VALUES($1,$2,$3,$4,82,$5) RETURNING id',
        [f.schoolA, exam, f.student, f.subject, f.admin],
      )
    ).rows[0].id;
    await db.exec(await readFile('db/migrations/' + files.at(-1), 'utf8'));
    expect(
      (await db.query('SELECT score,exam_id FROM marks WHERE id=$1', [mark])).rows[0],
    ).toMatchObject({ score: '82.00', exam_id: exam });
    expect(
      (await db.query('SELECT assessment_kind,subject_id FROM exams WHERE id=$1', [exam])).rows[0],
    ).toEqual({ assessment_kind: 'OFFICIAL', subject_id: null });
    expect(
      (
        await db.query('SELECT subject_id FROM teacher_class_assignments WHERE school_id=$1', [
          f.schoolA,
        ])
      ).rows[0].subject_id,
    ).toBeNull();
    await db.exec(
      `BEGIN;SET LOCAL ROLE app_api;SELECT set_config('app.school_id','${f.schoolA}',true),set_config('app.user_id','${f.teacher}',true);`,
    );
    expect(
      (
        await db.query('SELECT app.teacher_assigned($1,$2,$3) AS allowed', [
          f.schoolA,
          f.classId,
          f.subject,
        ])
      ).rows[0].allowed,
    ).toBe(false);
    expect((await db.query('SELECT id FROM exams')).rows).toEqual([]);
    await db.exec('ROLLBACK');
    expect(
      (
        await db.query(
          "SELECT has_function_privilege('anon','app.teacher_mark_access(uuid,uuid,uuid)','EXECUTE') AS allowed",
        )
      ).rows[0].allowed,
    ).toBe(false);
  } finally {
    await db.close();
  }
});
