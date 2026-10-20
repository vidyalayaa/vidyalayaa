import { beforeAll, afterAll, it, expect } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { portableDatabase } from '../helpers/database.js';
let db: PGlite;
beforeAll(async () => {
  db = await portableDatabase();
});
afterAll(async () => db.close());
it('requires explicit ownership for every application table', async () => {
  const global = new Set([
    'schools',
    'users',
    'roles',
    'permissions',
    'role_permissions',
    'platform_staff',
    'subscription_plans',
    'firmware_releases',
    'organizations',
    'worker_instances',
    'audit_logs',
    'billing_webhook_events',
    'provider_buckets',
  ]);
  const rows = (
    await db.query<{ table_name: string; is_nullable: string | null }>(
      "SELECT c.relname AS table_name,a.attnotnull::text AS is_nullable FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='school_id' AND NOT a.attisdropped WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname",
    )
  ).rows;
  expect(rows.filter((r) => !global.has(r.table_name) && r.is_nullable !== 'true')).toEqual([]);
});
it('uses composite school keys for every relationship between two tenant-owned tables', async () => {
  const unsafe = (
    await db.query(
      "SELECT child.relname AS child,parent.relname AS parent,k.conname FROM pg_constraint k JOIN pg_class child ON child.oid=k.conrelid JOIN pg_namespace n ON n.oid=child.relnamespace JOIN pg_class parent ON parent.oid=k.confrelid JOIN pg_attribute ca ON ca.attrelid=child.oid AND ca.attname='school_id' AND ca.attnotnull JOIN pg_attribute pa ON pa.attrelid=parent.oid AND pa.attname='school_id' AND pa.attnotnull WHERE k.contype='f' AND n.nspname='public' AND (NOT ca.attnum=ANY(k.conkey) OR NOT pa.attnum=ANY(k.confkey))",
    )
  ).rows;
  expect(unsafe).toEqual([]);
});
it('grants neither browser role any direct application table access', async () => {
  const leaked = (
    await db.query(
      "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND (has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') OR has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE'))",
    )
  ).rows;
  expect(leaked).toEqual([]);
});
