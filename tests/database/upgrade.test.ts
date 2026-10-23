import { providerSessionSchema } from '../helpers/provider-sessions.js';
import { it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { readFile, readdir } from 'node:fs/promises';
import { fixture } from '../helpers/database.js';
it('upgrades the nine-migration release without losing identities, child links or existing report evidence', async () => {
  const db = new PGlite({ extensions: { btree_gist, pgcrypto, citext } });
  try {
    await db.exec(
      "CREATE SCHEMA auth;CREATE SCHEMA storage;CREATE ROLE anon;CREATE ROLE authenticated;CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb DEFAULT '{}');CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
    );
    const files = (await readdir('db/migrations')).sort();
    await db.exec(providerSessionSchema);
    for (const file of files.slice(0, 9))
      await db.exec(await readFile('db/migrations/' + file, 'utf8'));
    const f = await fixture(db),
      report = crypto.randomUUID();
    await db.query(
      "INSERT INTO report_documents(id,school_id,kind,parameters,requested_by,status,storage_path) VALUES($1,$2,'ATTENDANCE',$3,$4,'COMPLETED',$5)",
      [
        report,
        f.schoolA,
        { from: '2026-01-01', to: '2026-01-31' },
        f.admin,
        f.schoolA + '/reports/legacy.pdf',
      ],
    );
    const old = (
      await db.query('SELECT id,school_id,student_id,parent_id FROM student_parents ORDER BY id')
    ).rows;

    for (const file of files.slice(9))
      await db.exec(await readFile('db/migrations/' + file, 'utf8'));
    expect(
      (await db.query('SELECT id,school_id,student_id,parent_id FROM student_parents ORDER BY id'))
        .rows,
    ).toEqual(old);
    const retained = (
      await db.query<{ status: string; authorization_version: string | null }>(
        'SELECT status,authorization_version FROM report_documents WHERE id=$1',
        [report],
      )
    ).rows[0];
    expect(retained.status).toBe('COMPLETED');
    expect(Number(retained.authorization_version || 0)).toBe(0);
    expect(
      Number((await db.query<{ count: number }>('SELECT count(*) FROM auth.users')).rows[0].count),
    ).toBe(5);
    await db.exec(await readFile('db/tests/verify.sql', 'utf8'));
  } finally {
    await db.close();
  }
});
