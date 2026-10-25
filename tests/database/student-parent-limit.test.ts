import { it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { readFile, readdir } from 'node:fs/promises';
import { fixture, poolAdapters } from '../helpers/database.js';
import { providerSessionSchema } from '../helpers/provider-sessions.js';
import { transaction } from '../../apps/api/src/lib/db.js';

it('preserves legacy families above the limit and enforces two active parents for inserts, reactivation and moved links', async () => {
  const migration = '20261025101219_student_parent_limit.sql';
  const db = new PGlite({ extensions: { btree_gist, pgcrypto, citext } });
  try {
    await db.exec(
      "CREATE SCHEMA auth;CREATE SCHEMA storage;CREATE ROLE anon;CREATE ROLE authenticated;CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb DEFAULT '{}');CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
    );
    await db.exec(providerSessionSchema);
    for (const file of (await readdir('db/migrations')).sort().filter((f) => f < migration))
      await db.exec(await readFile('db/migrations/' + file, 'utf8'));
    const f = await fixture(db);
    const parents: string[] = [];
    const links: string[] = [];
    for (let i = 0; i < 3; i++) {
      const p = (
        await db.query<{ id: string }>(
          'INSERT INTO parents(school_id,full_name) VALUES($1,$2) RETURNING id',
          [f.schoolA, `Legacy parent ${i}`],
        )
      ).rows[0].id;
      parents.push(p);
      if (i < 2)
        links.push(
          (
            await db.query<{ id: string }>(
              "INSERT INTO student_parents(school_id,student_id,parent_id,relationship) VALUES($1,$2,$3,'GUARDIAN') RETURNING id",
              [f.schoolA, f.student, p],
            )
          ).rows[0].id,
        );
    }
    const before = (await db.query('SELECT * FROM student_parents ORDER BY id')).rows;
    await db.exec(await readFile('db/migrations/' + migration, 'utf8'));
    expect((await db.query('SELECT * FROM student_parents ORDER BY id')).rows).toEqual(before);
    const pool = poolAdapters(db).api,
      ctx = { schoolId: f.schoolA, userId: f.admin };
    const attach = () =>
      transaction(pool, ctx, (tx) =>
        tx.query(
          "INSERT INTO student_parents(school_id,student_id,parent_id,relationship) VALUES($1,$2,$3,'GUARDIAN')",
          [f.schoolA, f.student, parents[2]],
        ),
      );
    await expect(attach()).rejects.toThrow('STUDENT_PARENT_LIMIT');
    // Existing links remain editable and revocable; no history is deleted.
    await transaction(pool, ctx, (tx) =>
      tx.query('UPDATE student_parents SET can_receive_alerts=false WHERE id=$1', [links[0]]),
    );
    await transaction(pool, ctx, (tx) =>
      tx.query("UPDATE student_parents SET status='REVOKED' WHERE id=ANY($1::uuid[])", [links]),
    );
    await attach();
    await expect(
      transaction(pool, ctx, (tx) =>
        tx.query("UPDATE student_parents SET status='ACTIVE' WHERE id=$1", [links[0]]),
      ),
    ).rejects.toThrow('STUDENT_PARENT_LIMIT');
    const other = (
      await db.query<{ id: string }>(
        "INSERT INTO students(school_id,student_code,first_name) VALUES($1,'PARENT_MOVE','Other learner') RETURNING id",
        [f.schoolA],
      )
    ).rows[0].id;
    const moved = (
      await transaction(pool, ctx, (tx) =>
        tx.query(
          "INSERT INTO student_parents(school_id,student_id,parent_id,relationship) VALUES($1,$2,$3,'GUARDIAN') RETURNING id",
          [f.schoolA, other, parents[0]],
        ),
      )
    ).rows[0].id;
    await expect(
      transaction(pool, ctx, (tx) =>
        tx.query('UPDATE student_parents SET student_id=$1 WHERE id=$2', [f.student, moved]),
      ),
    ).rejects.toThrow('STUDENT_PARENT_LIMIT');
    expect(
      (
        await db.query("SELECT id FROM student_parents WHERE student_id=$1 AND status='ACTIVE'", [
          f.student,
        ])
      ).rows,
    ).toHaveLength(2);
    expect(
      (await db.query('SELECT id FROM student_parents WHERE id=ANY($1::uuid[])', [links])).rows,
    ).toHaveLength(2);
    expect(
      (
        await db.query(
          "SELECT prosecdef FROM pg_proc WHERE oid='app.enforce_student_parent_limit()'::regprocedure",
        )
      ).rows[0].prosecdef,
    ).toBe(false);
  } finally {
    await db.close();
  }
});
