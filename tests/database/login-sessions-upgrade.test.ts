import { it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { readFileSync, readdirSync } from 'node:fs';
import { providerSessionSchema } from '../helpers/provider-sessions.js';
import { fixture } from '../helpers/database.js';
it('preserves existing provider sessions, credentials and school records without queuing historical login alerts', async () => {
  const db = new PGlite({ extensions: { btree_gist, pgcrypto, citext } }),
    migration = '20261023151112_login_sessions.sql';
  try {
    await db.exec(
      "CREATE SCHEMA auth;CREATE SCHEMA storage;CREATE ROLE anon;CREATE ROLE authenticated;CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb DEFAULT '{}');CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
    );
    await db.exec(providerSessionSchema);
    for (const file of readdirSync('db/migrations')
      .sort()
      .filter((f) => f !== migration))
      await db.exec(readFileSync('db/migrations/' + file, 'utf8'));
    const f = await fixture(db),
      sid = crypto.randomUUID();
    await db.query(
      "INSERT INTO auth.sessions(id,user_id,created_at,refreshed_at,user_agent,ip) VALUES($1,$2,now()-interval '2 days',now()-interval '1 hour','Original browser','192.0.2.1')",
      [sid, f.admin],
    );
    await db.query(
      "INSERT INTO auth.refresh_tokens(session_id,token) VALUES($1,'private-fixture-token')",
      [sid],
    );
    const tables = [
      'auth.sessions',
      'auth.refresh_tokens',
      'schools',
      'school_memberships',
      'students',
      'student_parents',
    ];
    const before = await Promise.all(
      tables.map((t) => db.query('SELECT * FROM ' + t + ' ORDER BY id')),
    );
    await db.exec(readFileSync('db/migrations/' + migration, 'utf8'));
    const after = await Promise.all(
      tables.map((t) => db.query('SELECT * FROM ' + t + ' ORDER BY id')),
    );
    expect(after.map((r) => r.rows)).toEqual(before.map((r) => r.rows));
    expect(
      (await db.query('SELECT app.observe_login_session($1,$2) AS live', [f.admin, sid])).rows[0],
    ).toEqual({ live: true });
    expect((await db.query('SELECT * FROM app.account_security_events')).rows).toHaveLength(0);
    expect((await db.query('SELECT * FROM app.login_session_activity')).rows).toHaveLength(1);
    await db.exec(readFileSync('db/tests/verify.sql', 'utf8'));
  } finally {
    await db.close();
  }
});
