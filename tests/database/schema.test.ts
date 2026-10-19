import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { assertRuntimeRole } from '../../apps/api/src/lib/runtime-role.js';
import { poolAdapters } from '../helpers/database.js';
import { readFileSync, readdirSync } from 'node:fs';
let db: PGlite;
const A = '00000000-0000-4000-8000-000000000001',
  B = '00000000-0000-4000-8000-000000000002',
  U = '00000000-0000-4000-8000-000000000003';
beforeAll(async () => {
  db = new PGlite({ extensions: { btree_gist, citext, pgcrypto } });
  await db.exec(
    "CREATE SCHEMA auth; CREATE SCHEMA storage; CREATE ROLE anon; CREATE ROLE authenticated; CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb DEFAULT '{}'); CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
  );
  for (const file of readdirSync('db/migrations').sort()) {
    const sql = readFileSync(`db/migrations/${file}`, 'utf8');
    await db.exec(sql);
  }
  await db.query(
    "INSERT INTO schools(id,school_code,name) VALUES($1,'A','School A'),($2,'B','School B')",
    [A, B],
  );
  await db.query("INSERT INTO auth.users(id,email) VALUES($1,'test@example.invalid')", [U]);
});
afterAll(async () => {
  await db?.close();
});
describe('TEST-REQ-045 schema and policy existence', () => {
  it('forces RLS on every public table', async () => {
    const r = await db.query<{ relname: string }>(
      "SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)",
    );
    expect(r.rows).toEqual([]);
  });
  it('uses non-bypass application roles', async () => {
    expect(
      (
        await db.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM pg_roles WHERE rolname IN ('app_api','app_device','app_worker','app_platform') AND (rolsuper OR rolbypassrls)",
        )
      ).rows[0].count,
    ).toBe(0);
  });
  it('prevents browser PostgREST access', async () => {
    expect(
      (
        await db.query<{ ok: boolean }>(
          "SELECT has_table_privilege('authenticated','students','SELECT') AS ok",
        )
      ).rows[0].ok,
    ).toBe(false);
  });
  it('does not grant platform staff student data privileges', async () => {
    expect(
      (
        await db.query<{ ok: boolean }>(
          "SELECT has_table_privilege('app_platform','students','SELECT') AS ok",
        )
      ).rows[0].ok,
    ).toBe(false);
  });
  it('keeps audit append-only', async () => {
    expect(
      (
        await db.query<{ ok: boolean }>(
          "SELECT has_table_privilege('app_api','audit_logs','UPDATE') OR has_table_privilege('app_api','audit_logs','DELETE') AS ok",
        )
      ).rows[0].ok,
    ).toBe(false);
  });
});
describe('TEN-REQ cross-school defense in depth', () => {
  it('denies reads without context and blocks foreign school inserts', async () => {
    await db.exec('SET ROLE app_api');
    expect((await db.query('SELECT * FROM students')).rows).toHaveLength(0);
    await db.query("SELECT set_config('app.school_id',$1,false)", [A]);
    await expect(
      db.query("INSERT INTO students(school_id,student_code,first_name) VALUES($1,'BAD','Bad')", [
        B,
      ]),
    ).rejects.toThrow(/row-level security/i);
    await db.exec('RESET ROLE');
  });
  it('RLS hides rows even when a query omits school filters', async () => {
    await db.query(
      "INSERT INTO students(school_id,student_code,first_name) VALUES($1,'A1','Alpha'),($2,'B1','Beta')",
      [A, B],
    );
    await db.exec('SET ROLE app_api');
    await db.query("SELECT set_config('app.school_id',$1,false)", [A]);
    const r = await db.query<{ first_name: string }>('SELECT first_name FROM students');
    expect(r.rows.map((x) => x.first_name)).toEqual(['Alpha']);
    await db.exec('RESET ROLE');
  });
  it('rejects a cross-school parent link at the composite FK', async () => {
    const student = (
      await db.query<{ id: string }>('SELECT id FROM students WHERE school_id=$1', [A])
    ).rows[0].id;
    const parent = (
      await db.query<{ id: string }>(
        "INSERT INTO parents(school_id,full_name) VALUES($1,'Parent B') RETURNING id",
        [B],
      )
    ).rows[0].id;
    await expect(
      db.query(
        "INSERT INTO student_parents(school_id,student_id,parent_id,relationship) VALUES($1,$2,$3,'GUARDIAN')",
        [A, student, parent],
      ),
    ).rejects.toThrow(/foreign key/i);
  });
  it('prevents two active cards for a student', async () => {
    const student = (
      await db.query<{ id: string }>('SELECT id FROM students WHERE school_id=$1', [A])
    ).rows[0].id;
    await db.query(
      "INSERT INTO nfc_cards(school_id,student_id,card_uid,issued_by) VALUES($1,$2,'AABBCCDD',$3)",
      [A, student, U],
    );
    await expect(
      db.query(
        "INSERT INTO nfc_cards(school_id,student_id,card_uid,issued_by) VALUES($1,$2,'11223344',$3)",
        [A, student, U],
      ),
    ).rejects.toThrow(/unique/i);
  });
});

it('startup rejects privileged and mismatched runtime database roles', async () => {
  const pools = poolAdapters(db);
  await expect(assertRuntimeRole(pools.api, 'app_api')).resolves.toBeUndefined();
  await expect(
    assertRuntimeRole(db as unknown as Parameters<typeof assertRuntimeRole>[0], 'app_api'),
  ).rejects.toThrow(/Unsafe runtime/);
  await expect(assertRuntimeRole(pools.device, 'app_api')).rejects.toThrow(/Unsafe runtime/);
});
