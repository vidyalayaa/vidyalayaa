import { it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { readFile, readdir } from 'node:fs/promises';
import { providerSessionSchema } from '../helpers/provider-sessions.js';
import { fixture } from '../helpers/database.js';
it('adds restrictive student profile policies without changing columns, records, family links or enrollments', async () => {
  const db = new PGlite({ extensions: { btree_gist, pgcrypto, citext } }),
    migration = '20261028164103_student_profile_scope.sql';
  try {
    await db.exec(
      "CREATE SCHEMA auth;CREATE SCHEMA storage;CREATE ROLE anon;CREATE ROLE authenticated;CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb DEFAULT '{}');CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
    );
    await db.exec(providerSessionSchema);
    const files = (await readdir('db/migrations')).sort();
    for (const file of files.filter((x) => x < migration))
      await db.exec(await readFile('db/migrations/' + file, 'utf8'));
    await fixture(db);
    const tables = [
        'students',
        'parents',
        'student_parents',
        'classes',
        'academic_sessions',
        'enrollments',
      ],
      before = new Map<string, unknown>();
    for (const table of tables)
      before.set(table, (await db.query(`SELECT * FROM ${table} ORDER BY id`)).rows);
    const columns = (
      await db.query(
        "SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position",
      )
    ).rows;
    await db.exec(await readFile('db/migrations/' + migration, 'utf8'));
    for (const table of tables)
      expect((await db.query(`SELECT * FROM ${table} ORDER BY id`)).rows).toEqual(
        before.get(table),
      );
    expect(
      (
        await db.query(
          "SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position",
        )
      ).rows,
    ).toEqual(columns);
    for (const file of files.filter((x) => x > migration))
      await db.exec(await readFile('db/migrations/' + file, 'utf8'));
    await db.exec(await readFile('db/tests/verify.sql', 'utf8'));
  } finally {
    await db.close();
  }
});
