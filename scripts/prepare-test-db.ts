import pg from 'pg';
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test'))
  throw new Error('Use a dedicated database ending in _test. Never use a school database.');
const db = new pg.Client({ connectionString: url, ssl: false });
await db.connect();
try {
  await db.query(
    "CREATE SCHEMA IF NOT EXISTS auth;CREATE SCHEMA IF NOT EXISTS storage;DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated;END IF;END $$;CREATE TABLE IF NOT EXISTS auth.users(id uuid PRIMARY KEY,email text,raw_user_meta_data jsonb DEFAULT '{}');CREATE TABLE IF NOT EXISTS storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
  );
} finally {
  await db.end();
}
