import { it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { readFileSync, readdirSync } from 'node:fs';
import { providerSessionSchema } from '../helpers/provider-sessions.js';
import { fixture } from '../helpers/database.js';

it('repairs verified account email drift on upgrade without relinking school records', async () => {
  const db = new PGlite({ extensions: { btree_gist, pgcrypto, citext } });
  try {
    await db.exec(
      "CREATE SCHEMA auth;CREATE SCHEMA storage;CREATE ROLE anon;CREATE ROLE authenticated;CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb DEFAULT '{}');CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[])",
    );
    await db.exec(providerSessionSchema);
    const migration = '20261026033231_account_settings.sql';
    for (const file of readdirSync('db/migrations')
      .sort()
      .filter((x) => x < migration))
      await db.exec(readFileSync('db/migrations/' + file, 'utf8'));
    const f = await fixture(db);
    const before = await db.query(
      'SELECT id,school_id,user_id FROM school_memberships ORDER BY id',
    );
    const student = await db.query('SELECT id,user_id,email FROM students ORDER BY id');
    const oldParent = (
      await db.query<{ email: string }>('SELECT email FROM users WHERE id=$1', [f.parent])
    ).rows[0].email;
    await db.query(
      "UPDATE auth.users SET email='verified-new@example.test',email_confirmed_at=now() WHERE id=$1",
      [f.admin],
    );
    await db.query("UPDATE auth.users SET email='unconfirmed-new@example.test' WHERE id=$1", [
      f.parent,
    ]);
    await db.exec(readFileSync('db/migrations/' + migration, 'utf8'));
    expect(
      (await db.query<{ email: string }>('SELECT email::text FROM users WHERE id=$1', [f.admin]))
        .rows[0].email,
    ).toBe('verified-new@example.test');
    expect(
      (await db.query<{ email: string }>('SELECT email::text FROM users WHERE id=$1', [f.parent]))
        .rows[0].email,
    ).toBe(oldParent);
    await db.query('UPDATE auth.users SET email_confirmed_at=now() WHERE id=$1', [f.parent]);
    expect(
      (await db.query<{ email: string }>('SELECT email::text FROM users WHERE id=$1', [f.parent]))
        .rows[0].email,
    ).toBe('unconfirmed-new@example.test');
    // Current verification includes newer parent RLS; advance the historical
    // account-settings fixture before checking the complete deployed schema.
    for (const file of readdirSync('db/migrations')
      .sort()
      .filter((x) => x > migration))
      await db.exec(readFileSync('db/migrations/' + file, 'utf8'));
    expect(
      (await db.query('SELECT id,school_id,user_id FROM school_memberships ORDER BY id')).rows,
    ).toEqual(before.rows);
    expect((await db.query('SELECT id,user_id,email FROM students ORDER BY id')).rows).toEqual(
      student.rows,
    );
    await db.exec(readFileSync('db/tests/verify.sql', 'utf8'));
  } finally {
    await db.close();
  }
});
