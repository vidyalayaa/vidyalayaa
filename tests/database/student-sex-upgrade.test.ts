import { it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { readFile, readdir } from 'node:fs/promises';
import { fixture } from '../helpers/database.js';

it('adds recorded sex without altering existing students, enrollments, family links or RLS', async () => {
  const db = new PGlite({ extensions: { btree_gist, pgcrypto, citext } });
  const migration = '20261022141625_student_sex_counts.sql';
  try {
    await db.exec(
      "CREATE SCHEMA auth;CREATE SCHEMA storage;CREATE ROLE anon;CREATE ROLE authenticated;CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb DEFAULT '{}');CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
    );
    for (const file of (await readdir('db/migrations')).sort().filter((f) => f < migration))
      await db.exec(await readFile('db/migrations/' + file, 'utf8'));
    const f = await fixture(db);
    const before = (await db.query('SELECT * FROM students ORDER BY id')).rows;
    const enrollments = (await db.query('SELECT * FROM enrollments ORDER BY id')).rows;
    const links = (await db.query('SELECT * FROM student_parents ORDER BY id')).rows;
    await db.exec(await readFile('db/migrations/' + migration, 'utf8'));
    const after = (await db.query('SELECT * FROM students ORDER BY id')).rows;
    expect(after.map(({ sex, ...row }) => row)).toEqual(before);
    expect(after.every((row) => row.sex === 'NOT_SPECIFIED')).toBe(true);
    expect((await db.query('SELECT * FROM enrollments ORDER BY id')).rows).toEqual(enrollments);
    expect((await db.query('SELECT * FROM student_parents ORDER BY id')).rows).toEqual(links);
    await expect(
      db.query("UPDATE students SET sex='INVALID' WHERE id=$1", [f.student]),
    ).rejects.toThrow(/students_sex_check/);
    await expect(db.query('UPDATE students SET sex=NULL WHERE id=$1', [f.student])).rejects.toThrow(
      /not-null/,
    );
    await db.exec(
      `BEGIN;SET LOCAL ROLE app_api;SELECT set_config('app.school_id','${f.schoolA}',true),set_config('app.user_id','${f.admin}',true);`,
    );
    expect((await db.query('SELECT id,sex FROM students')).rows).toEqual([
      { id: f.student, sex: 'NOT_SPECIFIED' },
    ]);
    await db.exec('ROLLBACK');
    expect(
      (
        await db.query(
          "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='students'::regclass",
        )
      ).rows[0],
    ).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    expect(
      (await db.query("SELECT has_table_privilege('authenticated','students','SELECT') AS allowed"))
        .rows[0].allowed,
    ).toBe(false);
  } finally {
    await db.close();
  }
});
