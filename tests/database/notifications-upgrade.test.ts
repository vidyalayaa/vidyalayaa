import { it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { readFileSync, readdirSync } from 'node:fs';
import { providerSessionSchema } from '../helpers/provider-sessions.js';
import { fixture } from '../helpers/database.js';
it('upgrades existing notification records without resending, rewriting tokens or changing school data', async () => {
  const db = new PGlite({ extensions: { btree_gist, pgcrypto, citext } }),
    migration = '20261024085300_school_notifications.sql';
  try {
    await db.exec(
      "CREATE SCHEMA auth;CREATE SCHEMA storage;CREATE ROLE anon;CREATE ROLE authenticated;CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb DEFAULT '{}');CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
    );
    await db.exec(providerSessionSchema);
    for (const file of readdirSync('db/migrations')
      .sort()
      .filter((f) => f < migration))
      await db.exec(readFileSync('db/migrations/' + file, 'utf8'));
    const f = await fixture(db);
    const oid = crypto.randomUUID();
    await db.query(
      "INSERT INTO notification_outbox(id,school_id,kind,dedupe_key,payload,status) VALUES($1,$2,'STUDENT_ARRIVED','original','{}','COMPLETED')",
      [oid, f.schoolA],
    );
    await db.query(
      "INSERT INTO notification_deliveries(school_id,outbox_id,parent_id,channel,status) VALUES($1,$2,$3,'PUSH','SENT')",
      [f.schoolA, oid, f.parentId],
    );
    const tables = [
      'schools',
      'school_memberships',
      'students',
      'parents',
      'student_parents',
      'notification_deliveries',
      'push_tokens',
    ];
    const before = await Promise.all(
      tables.map((t) => db.query('SELECT * FROM ' + t + ' ORDER BY id')),
    );
    await db.exec(readFileSync('db/migrations/' + migration, 'utf8'));
    const after = await Promise.all(
      tables.map((t) => db.query('SELECT * FROM ' + t + ' ORDER BY id')),
    );
    expect(after.map((x) => x.rows)).toEqual(before.map((x) => x.rows));
    expect(
      (
        await db.query(
          'SELECT status,created_by,cancelled_at FROM notification_outbox WHERE id=$1',
          [oid],
        )
      ).rows[0],
    ).toEqual({ status: 'COMPLETED', created_by: null, cancelled_at: null });
    expect((await db.query('SELECT * FROM notification_recipient_targets')).rows).toHaveLength(0);
    // Verify the current schema only after advancing beyond this historical
    // notification-only upgrade; later migrations include the Gender rename.
    for (const file of readdirSync('db/migrations')
      .sort()
      .filter((f) => f > migration))
      await db.exec(readFileSync('db/migrations/' + file, 'utf8'));
    await db.exec(readFileSync('db/tests/verify.sql', 'utf8'));
  } finally {
    await db.close();
  }
});
