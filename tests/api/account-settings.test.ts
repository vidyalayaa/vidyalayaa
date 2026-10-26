import { beforeAll, afterAll, it, expect } from 'vitest';
import request from 'supertest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PGlite } from '@electric-sql/pglite';
import { portableDatabase, poolAdapters, fixture } from '../helpers/database.js';
import { fixtureBearer, withProviderSessions } from '../helpers/provider-sessions.js';
import { transaction } from '../../apps/api/src/lib/db.js';
import { createApp } from '../../apps/api/src/app.js';
import type { Config } from '../../apps/api/src/lib/config.js';

let db: PGlite,
  f: Awaited<ReturnType<typeof fixture>>,
  pools: ReturnType<typeof poolAdapters>,
  app: ReturnType<typeof createApp>;
const root = crypto.randomUUID(),
  unassigned = crypto.randomUUID();
const token = (id: string) =>
  fixtureBearer(
    'test.' +
      Buffer.from(JSON.stringify({ sub: id, aal: 'aal2' })).toString('base64url') +
      '.verified',
  );
const call = (id: string, suffix = '') =>
  request(app)
    .get('/api/v1/account/credentials' + suffix)
    .set('Authorization', 'Bearer ' + token(id));
beforeAll(async () => {
  db = await portableDatabase();
  pools = poolAdapters(db);
  f = await fixture(db);
  await db.exec(
    "ALTER TABLE auth.users ADD COLUMN encrypted_password text DEFAULT '';ALTER TABLE auth.users ADD COLUMN email_change text DEFAULT ''",
  );
  for (const id of [root, unassigned])
    await db.query('INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,$2,now())', [
      id,
      id + '@example.test',
    ]);
  await db.query("INSERT INTO platform_staff(user_id,platform_role) VALUES($1,'SUPER_ADMIN')", [
    root,
  ]);
  await db.query(
    "UPDATE auth.users SET encrypted_password='private-test-hash-never-return-this',email_confirmed_at=now() WHERE id=$1",
    [f.admin],
  );
  const known = new Set([
    root,
    unassigned,
    f.admin,
    f.principal,
    f.teacher,
    f.parent,
    f.studentUser,
  ]);
  const auth = {
    auth: {
      getUser: async (bearer: string) => {
        const id = JSON.parse(Buffer.from(bearer.split('.')[1], 'base64url').toString()).sub;
        return known.has(id)
          ? { data: { user: { id, factors: [] } }, error: null }
          : { data: { user: null }, error: { status: 401 } };
      },
    },
  } as unknown as SupabaseClient;
  app = createApp(
    {
      NODE_ENV: 'test',
      WEB_ORIGINS: 'http://localhost:5173',
      TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32),
      TRUST_PROXY_HOPS: 0,
    } as Config,
    { ...pools, supabase: withProviderSessions(db, auth) },
  );
});
afterAll(async () => db?.close());
it('requires authentication and never accepts a target user ID', async () => {
  expect((await request(app).get('/api/v1/account/credentials')).status).toBe(401);
  expect((await call(f.admin, '?user_id=' + f.parent)).status).toBe(422);
  expect((await call(f.admin, '/' + f.parent)).status).toBe(404);
});
it('returns only owned credential presence for every role and unassigned accounts', async () => {
  for (const id of [root, unassigned, f.admin, f.principal, f.teacher, f.parent, f.studentUser]) {
    const result = await call(id);
    expect(result.status).toBe(200);
    expect(Object.keys(result.body).sort()).toEqual([
      'email',
      'email_confirmed',
      'has_password',
      'pending_email',
    ]);
    expect(result.body.has_password).toBe(id === f.admin);
    expect(result.body.email).toBe(
      (await db.query<{ email: string }>('SELECT email FROM auth.users WHERE id=$1', [id])).rows[0]
        .email,
    );
    expect(JSON.stringify(result.body)).not.toContain('private-test-hash');
  }
});
it('keeps pending changes separate and syncs only confirmed canonical email changes', async () => {
  const old = (await call(f.admin)).body.email;
  await db.query("UPDATE auth.users SET email_change='new-admin@example.test' WHERE id=$1", [
    f.admin,
  ]);
  expect((await call(f.admin)).body).toMatchObject({
    email: old,
    pending_email: 'new-admin@example.test',
  });
  expect(
    (await db.query<{ email: string }>('SELECT email::text FROM users WHERE id=$1', [f.admin]))
      .rows[0].email,
  ).toBe(old);
  await db.query(
    "UPDATE auth.users SET email='new-admin@example.test',email_change='' WHERE id=$1",
    [f.admin],
  );
  expect(
    (await db.query<{ email: string }>('SELECT email::text FROM users WHERE id=$1', [f.admin]))
      .rows[0].email,
  ).toBe('new-admin@example.test');
  expect(
    (
      await db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM school_memberships WHERE user_id=$1',
        [f.admin],
      )
    ).rows[0].n,
  ).toBeGreaterThan(0);
  await db.query(
    "UPDATE auth.users SET email='unverified@example.test',email_confirmed_at=NULL WHERE id=$1",
    [f.admin],
  );
  expect(
    (await db.query<{ email: string }>('SELECT email::text FROM users WHERE id=$1', [f.admin]))
      .rows[0].email,
  ).toBe('new-admin@example.test');
});
it('prevents browsers and platform database roles from reading credentials or updating auth tables', async () => {
  for (const role of ['anon', 'authenticated', 'app_platform', 'app_worker', 'app_device']) {
    expect(
      (
        await db.query<{ ok: boolean }>(
          "SELECT has_function_privilege($1,'app.account_credentials()','EXECUTE') AS ok",
          [role],
        )
      ).rows[0].ok,
    ).toBe(false);
  }
  expect(
    (
      await db.query<{ ok: boolean }>(
        "SELECT has_table_privilege('app_api','auth.users','SELECT') AS ok",
      )
    ).rows[0].ok,
  ).toBe(false);
  await expect(
    transaction(pools.api, { schoolId: '', userId: undefined }, (tx) =>
      tx.query('SELECT app.account_credentials()'),
    ),
  ).rejects.toThrow(/FORBIDDEN/);
});
