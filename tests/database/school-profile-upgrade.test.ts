import { it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFileSync, readdirSync } from 'node:fs';
import { providerSessionSchema } from '../helpers/provider-sessions.js';
import { fixture } from '../helpers/database.js';
import { defaultSchoolTimings } from '@vidyalayaa/contracts';
it('extends existing school identity in place without rewriting settings, academic records, families or fee history', async () => {
  const db = new PGlite({ extensions: { btree_gist, citext, pgcrypto } }),
    migration = '20261101131616_school_profile_management.sql';
  try {
    await db.exec(
      "CREATE SCHEMA auth;CREATE SCHEMA storage;CREATE ROLE anon;CREATE ROLE authenticated;CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb DEFAULT '{}');CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
    );
    await db.exec(providerSessionSchema);
    const migrations = readdirSync('db/migrations').sort();
    for (const name of migrations.filter((m) => m < migration))
      await db.exec(readFileSync('db/migrations/' + name, 'utf8'));
    const f = await fixture(db);
    await db.query('UPDATE schools SET settings=$2 WHERE id=$1', [
      f.schoolA,
      {
        locale: 'hi-IN',
        timetable: { ...defaultSchoolTimings, version: 1 },
        unrelated: { retain: true },
      },
    ]);
    const before = (await db.query('SELECT * FROM schools ORDER BY id')).rows;
    const tables = [
      'students',
      'parents',
      'student_parents',
      'enrollments',
      'teachers',
      'timetable_entries',
      'fee_records',
      'fee_payments',
    ];
    const rows = await Promise.all(tables.map((t) => db.query(`SELECT * FROM ${t} ORDER BY id`)));
    await db.exec(readFileSync('db/migrations/' + migration, 'utf8'));
    const after = (await db.query('SELECT * FROM schools ORDER BY id')).rows;
    expect(after.map(({ profile, profile_version, ...existing }) => existing)).toEqual(before);
    expect(after.every((s) => s.profile_version === 0 && JSON.stringify(s.profile) === '{}')).toBe(
      true,
    );
    for (let i = 0; i < tables.length; i++)
      expect((await db.query(`SELECT * FROM ${tables[i]} ORDER BY id`)).rows).toEqual(rows[i].rows);
    expect((await db.query('SELECT * FROM school_profile_private')).rows).toEqual([]);
    expect((await db.query('SELECT * FROM school_profile_assets')).rows).toEqual([]);
    expect(
      (
        await db.query(
          "SELECT public,allowed_mime_types FROM storage.buckets WHERE id='school-documents'",
        )
      ).rows[0],
    ).toMatchObject({
      public: false,
      allowed_mime_types: expect.arrayContaining([
        'application/pdf',
        'image/png',
        'image/jpeg',
        'image/webp',
      ]),
    });
    const rights = (
      await db.query(
        "SELECT has_table_privilege('anon','school_profile_private','SELECT') AS anon,has_table_privilege('authenticated','school_profile_assets','SELECT') AS browser,has_function_privilege('authenticated','app.school_profile_editor(uuid)','EXECUTE') AS helper,has_table_privilege('app_platform','students','SELECT') AS pupils",
      )
    ).rows[0];
    expect(rights).toEqual({ anon: false, browser: false, helper: false, pupils: false });
  } finally {
    await db.close();
  }
});
