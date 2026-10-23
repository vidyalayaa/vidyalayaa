import { providerSessionSchema } from '../helpers/provider-sessions.js';
import { it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { readFile, readdir } from 'node:fs/promises';
import { fixture } from '../helpers/database.js';
it('preserves every legacy lecture and existing school settings while installing restrictive timetable policies and guards', async () => {
  const db = new PGlite({ extensions: { btree_gist, pgcrypto, citext } }),
    migration = '20261023070540_school_timetable.sql';
  try {
    await db.exec(
      "CREATE SCHEMA auth;CREATE SCHEMA storage;CREATE ROLE anon;CREATE ROLE authenticated;CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb DEFAULT '{}');CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
    );
    await db.exec(providerSessionSchema);
    for (const file of (await readdir('db/migrations')).sort().filter((f) => f !== migration))
      await db.exec(await readFile('db/migrations/' + file, 'utf8'));
    const f = await fixture(db);
    await db.query(
      "UPDATE schools SET settings='{" + '"existing":"preserve"' + "}'::jsonb WHERE id=$1",
      [f.schoolA],
    );
    await db.query(
      "INSERT INTO timetable_entries(school_id,class_id,subject_id,teacher_id,weekday,starts_at,ends_at,room) VALUES($1,$2,$3,$4,7,'14:00:30','14:40:30','Legacy room')",
      [f.schoolA, f.classId, f.subject, f.teacherId],
    );
    const before = (await db.query('SELECT * FROM timetable_entries ORDER BY id')).rows,
      settings = (await db.query('SELECT settings FROM schools ORDER BY id')).rows;
    await db.exec(await readFile('db/migrations/' + migration, 'utf8'));
    expect((await db.query('SELECT * FROM timetable_entries ORDER BY id')).rows).toEqual(before);
    expect((await db.query('SELECT settings FROM schools ORDER BY id')).rows).toEqual(settings);
    expect(
      (
        await db.query(
          "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='timetable_entries'::regclass",
        )
      ).rows[0],
    ).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    expect(
      (
        await db.query(
          "SELECT has_table_privilege('authenticated','timetable_entries','SELECT') AS browser,has_function_privilege('anon','app.valid_timetable_settings(jsonb)','EXECUTE') AS validator",
        )
      ).rows[0],
    ).toEqual({ browser: false, validator: false });
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM pg_policy WHERE polrelid='timetable_entries'::regclass AND polname IN ('timetable_read','timetable_insert','timetable_update','timetable_delete') AND NOT polpermissive",
        )
      ).rows[0].count,
    ).toBe(4);
  } finally {
    await db.close();
  }
});
