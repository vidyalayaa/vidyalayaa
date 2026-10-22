import { it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { readFile, readdir } from 'node:fs/promises';
import { fixture } from '../helpers/database.js';
it('upgrades legacy calendar records in place, preserving dates, IDs, types and timestamps with strict role rules', async () => {
  const db = new PGlite({ extensions: { btree_gist, pgcrypto, citext } }),
    migration = '20261022144925_school_calendar_events.sql';
  try {
    await db.exec(
      "CREATE SCHEMA auth;CREATE SCHEMA storage;CREATE ROLE anon;CREATE ROLE authenticated;CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb DEFAULT '{}');CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
    );
    for (const file of (await readdir('db/migrations')).sort().filter((f) => f < migration))
      await db.exec(await readFile('db/migrations/' + file, 'utf8'));
    const f = await fixture(db);
    await db.query(
      "INSERT INTO school_holidays(school_id,on_date,kind,label,class_id) VALUES($1,'2027-01-01','HOLIDAY','Legacy school holiday',NULL),($1,'2027-01-02','SHORT_DAY','Legacy class short day',$2)",
      [f.schoolA, f.classId],
    );
    const columns = 'id,school_id,on_date,kind,label,class_id,created_at,updated_at,retired_at';
    const before = (await db.query(`SELECT ${columns} FROM school_holidays ORDER BY id`)).rows;
    await db.exec(await readFile('db/migrations/' + migration, 'utf8'));
    expect((await db.query(`SELECT ${columns} FROM school_holidays ORDER BY id`)).rows).toEqual(
      before,
    );
    const rows = (
      await db.query(
        'SELECT class_id,target_class_ids,ends_on,version FROM school_holidays ORDER BY id',
      )
    ).rows;
    for (const row of rows) {
      expect(row.target_class_ids).toEqual(row.class_id ? [row.class_id] : []);
      expect(row.ends_on).toBeNull();
      expect(row.version).toBe(1);
    }
    expect(
      (
        await db.query(
          "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='school_holidays'::regclass",
        )
      ).rows[0],
    ).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    expect(
      (
        await db.query(
          "SELECT has_table_privilege('authenticated','school_holidays','SELECT') AS browser,has_function_privilege('app_api','app.calendar_class_reference_guard()','EXECUTE') AS guard",
        )
      ).rows[0],
    ).toEqual({ browser: false, guard: false });
    await expect(db.query('DELETE FROM classes WHERE id=$1', [f.classId])).rejects.toThrow(
      /CLASS_HAS_CALENDAR_EVENTS|foreign key/,
    );
    await expect(
      db.query(
        "INSERT INTO school_holidays(school_id,on_date,kind,label,target_class_ids) VALUES($1,'2027-01-04','ACTIVITY','Bad target',ARRAY[gen_random_uuid()])",
        [f.schoolA],
      ),
    ).rejects.toThrow(/CALENDAR_TARGET_INVALID/);
  } finally {
    await db.close();
  }
});
