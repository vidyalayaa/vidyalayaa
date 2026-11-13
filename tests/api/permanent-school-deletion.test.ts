import { afterAll, beforeAll, expect, it } from 'vitest';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createApp } from '../../apps/api/src/app.js';
import type { Config } from '../../apps/api/src/lib/config.js';
import { transaction } from '../../apps/api/src/lib/db.js';
import { signedDownload } from '../../apps/api/src/lib/downloads.js';
import { purgeApprovedSchool } from '../../apps/worker/src/offboarding.js';
import { fixture, poolAdapters, portableDatabase } from '../helpers/database.js';
import { fixtureBearer, withProviderSessions } from '../helpers/provider-sessions.js';

let db: PGlite;
let pools: ReturnType<typeof poolAdapters>;
let app: ReturnType<typeof createApp>;
let f: Awaited<ReturnType<typeof fixture>>;
let root: string;
let registeredAgain: string | undefined;

beforeAll(async () => {
  db = await portableDatabase();
  f = await fixture(db);
  pools = poolAdapters(db);
  root = crypto.randomUUID();
  await db.query(
    "INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,'deletion-root@example.invalid',now())",
    [root],
  );
  await db.query("INSERT INTO platform_staff(user_id,platform_role) VALUES($1,'SUPER_ADMIN')", [
    root,
  ]);
  await db.query('UPDATE auth.users SET email_confirmed_at=now() WHERE id=$1', [f.admin]);
  await db.query(
    "INSERT INTO auth.mfa_factors(user_id,factor_type,status) VALUES($1,'totp','verified')",
    [f.admin],
  );
  await db.query(
    "INSERT INTO school_memberships(school_id,user_id,role_id) SELECT $1,$2,id FROM roles WHERE code='teacher'",
    [f.schoolB, f.teacher],
  );
  await db.exec(
    'CREATE UNIQUE INDEX fixture_provider_email ON auth.users(lower(email)); ALTER TABLE auth.users ADD COLUMN phone text UNIQUE',
  );
  await db.query('UPDATE auth.users SET phone=$2 WHERE id=$1', [f.admin, '+15550101234']);
  await db.query(
    `INSERT INTO subscriptions(school_id,plan_id,status,current_period_end)
     SELECT $1,id,'ACTIVE',now()+interval '30 days' FROM subscription_plans WHERE code='PROFESSIONAL'`,
    [f.schoolB],
  );
  const auth = {
    auth: {
      getUser: async (token: string) => {
        const [, , name] = token.split('.');
        const id = {
          root,
          admin: f.admin,
          principal: f.principal,
          teacher: f.teacher,
          registered: registeredAgain,
        }[name];
        return {
          data: { user: id ? { id, factors: [{ status: 'verified' }] } : null },
          error: null,
        };
      },
      admin: {
        inviteUserByEmail: async (email: string) => {
          registeredAgain = crypto.randomUUID();
          await db.exec('SET LOCAL ROLE NONE');
          try {
            await db.query("INSERT INTO auth.users(id,email,phone) VALUES($1,$2,'+15550101234')", [
              registeredAgain,
              email,
            ]);
          } finally {
            await db.exec('SET LOCAL ROLE app_platform');
          }
          return { data: { user: { id: registeredAgain } }, error: null };
        },
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

type TestActor = 'root' | 'admin' | 'principal' | 'teacher' | 'registered';
type TestResponse = {
  status: number;
  body: any;
  headers: ReturnType<ServerResponse['getHeaders']>;
};
function call(
  method: 'get',
  path: string,
  name: TestActor,
  recent?: boolean,
  school?: string,
): Promise<TestResponse>;
function call(
  method: 'post',
  path: string,
  name: TestActor,
  recent?: boolean,
  school?: string,
): { send: (body: unknown) => Promise<TestResponse> };
function call(
  method: 'get' | 'post',
  path: string,
  name: TestActor,
  recent = true,
  school = name === 'root' ? '' : f.schoolA,
) {
  const timestamp = Math.floor(Date.now() / 1000) - (recent ? 1 : 3600);
  const claims = Buffer.from(
    JSON.stringify({
      aal: 'aal2',
      amr: [{ method: 'totp', timestamp }],
      session_id: {
        admin: f.admin,
        teacher: f.teacher,
        root,
        principal: f.principal,
        registered: registeredAgain,
      }[name],
    }),
  ).toString('base64url');
  const send = (body?: unknown) =>
    new Promise<TestResponse>((resolve, reject) => {
      // Exercise the real Express middleware and router without a listening socket.
      const socket = new Socket();
      Object.defineProperty(socket, 'remoteAddress', { value: '127.0.0.1' });
      const req = new IncomingMessage(socket);
      req.method = method.toUpperCase();
      req.url = '/api/v1' + path;
      req.headers.authorization = 'Bearer ' + fixtureBearer(`fixture.${claims}.${name}`);
      if (school) req.headers['x-school-id'] = school;
      const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      if (encoded) {
        req.headers['content-type'] = 'application/json';
        req.headers['content-length'] = String(encoded.length);
      }
      const res = new ServerResponse(req);
      res.end = ((chunk?: Buffer | string) => {
        try {
          resolve({
            status: res.statusCode,
            body: chunk ? JSON.parse(chunk.toString()) : null,
            headers: res.getHeaders(),
          });
        } catch (error) {
          reject(error);
        }
        return res;
      }) as typeof res.end;
      app(req, res);
      if (encoded) req.push(encoded);
      req.push(null);
    });
  return method === 'post' ? { send } : send();
}

it('requires separate fresh MFA, consumes approval once, and retries a tenant-scoped erasure', async () => {
  const path = `/platform/schools/${f.schoolA}/permanent-deletion`;
  const inbox = '/offboarding/deletion-approval';
  const confirm = { confirm: 'DELETE', school_name: 'Test School A' };
  const day = 86400000;
  const before = await call('get', '/me', 'teacher', true, '');
  expect((await call('get', '/me', 'admin')).status).toBe(200);
  await db.query(
    "INSERT INTO auth.refresh_tokens(session_id,token) VALUES($1,'deleted-school-refresh'),($2,'shared-school-refresh')",
    [f.admin, f.teacher],
  );
  const oldInvitation = (
    await db.query<{ id: string }>(
      "INSERT INTO school_invitations(school_id,email,full_name,role_code,user_id,invited_by,status) VALUES($1,'old-invite@example.invalid','Old invite','teacher',$2,$3,'SENT') RETURNING id",
      [f.schoolA, f.teacher, f.admin],
    )
  ).rows[0].id;
  expect(before.body.memberships.map((m: { school_id: string }) => m.school_id).sort()).toEqual(
    [f.schoolA, f.schoolB].sort(),
  );
  const sharedIdentity = (await db.query('SELECT * FROM auth.users WHERE id=$1', [f.teacher])).rows;
  const sharedMembership = (
    await db.query('SELECT * FROM school_memberships WHERE school_id=$1 AND user_id=$2', [
      f.schoolB,
      f.teacher,
    ])
  ).rows;
  const email = (
    await db.query<{ email: string }>('SELECT email FROM auth.users WHERE id=$1', [f.admin])
  ).rows[0].email;
  await db.query(
    `INSERT INTO push_tokens(school_id,user_id,token_hash,token_encrypted,platform)
     VALUES($1,$3,$4,'fixture-token','WEB'),($1,$3,$5,'fixture-token','WEB'),($2,$3,$5,'fixture-token','WEB')`,
    [f.schoolA, f.schoolB, f.teacher, 'a'.repeat(64), 'b'.repeat(64)],
  );
  await db.query('INSERT INTO app.push_endpoint_owners(token_hash,user_id) VALUES($2,$1),($3,$1)', [
    f.teacher,
    'a'.repeat(64),
    'b'.repeat(64),
  ]);
  const body = {
    ...confirm,
    approver_id: f.admin,
    policy_ref: 'TEST-RETENTION',
    reason: 'Verify a permanent school erasure in a disposable fixture.',
    export_until: new Date(Date.now() + 2 * day).toISOString(),
    delete_after: new Date(Date.now() + 3 * day).toISOString(),
  };
  const nonAdmin = await call('post', path, 'admin').send(body);
  expect(nonAdmin.status, JSON.stringify(nonAdmin.body)).toBe(403);
  expect((await call('post', path, 'root', false).send(body)).status).toBe(403);
  expect((await call('post', path, 'root').send({ ...body, confirm: 'delete' })).status).toBe(422);
  expect(
    (await call('post', path, 'root').send({ ...body, school_name: 'Test School A ' })).status,
  ).toBe(400);
  expect(
    (await call('post', path, 'root').send({ ...body, approver_id: f.principal })).status,
  ).toBe(409);
  const expired = await call('post', path, 'root').send(body);
  expect(expired.status, JSON.stringify(expired.body)).toBe(201);
  const expiredToken = (await call('get', inbox, 'admin')).body.request.token;
  await db.query(
    "UPDATE school_offboarding SET approval_expires_at=now()-interval '1 second' WHERE id=$1",
    [expired.body.id],
  );
  expect(
    (
      await call('post', inbox + '/' + expired.body.id, 'admin').send({
        token: expiredToken,
        approve: true,
      })
    ).status,
  ).toBe(409);

  const created = await call('post', path, 'root').send(body);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const job = created.body.id;
  expect(created.body.token).toBeUndefined();
  expect((await call('post', path, 'root').send(body)).status).toBe(409);
  expect((await call('get', inbox, 'principal')).status).toBe(404);
  const pending = await call('get', inbox, 'admin');
  expect(pending.headers['cache-control']).toBe('no-store');
  const token = pending.body.request.token;
  expect(
    (await call('post', inbox + '/' + job, 'admin', false).send({ token, approve: true })).status,
  ).toBe(403);
  expect(
    (await call('post', inbox + '/' + job, 'admin').send({ token: expiredToken, approve: true }))
      .status,
  ).toBe(404);
  expect(
    (
      await call('post', `/offboarding/${job}/approve`, 'admin').send({
        approve: true,
        policy_ref: body.policy_ref,
      })
    ).status,
  ).toBe(404);
  expect(
    (await call('post', inbox + '/' + job, 'admin').send({ token, approve: true })).status,
  ).toBe(204);
  expect(
    (await call('post', inbox + '/' + job, 'admin').send({ token, approve: true })).status,
  ).toBe(409);
  await db.query('UPDATE devices SET last_seen_at=now() WHERE school_id=$1', [f.schoolA]);
  const closed = await call('post', `/platform/offboarding/${job}/close`, 'root').send({
    confirm: 'CLOSE_SCHOOL',
  });
  expect(closed.status, JSON.stringify(closed.body)).toBe(204);
  const oldSchoolProfile = await call('get', `/platform/schools/${f.schoolA}/profile`, 'root');
  expect(oldSchoolProfile.status).toBe(200);

  const execute = path + '/' + job + '/execute';
  expect((await call('post', execute, 'root').send(confirm)).status).toBe(409);
  await db.query(
    "UPDATE school_offboarding SET closed_at=now()-interval '3 days',export_until=now()-interval '2 days',delete_after=now()-interval '1 day' WHERE id=$1",
    [job],
  );
  expect(
    (
      await call('post', `/platform/offboarding/${job}/hold`, 'root').send({
        enabled: false,
        reason: 'Fixture retention reviewed.',
        policy_ref: body.policy_ref,
      })
    ).status,
  ).toBe(204);
  expect((await call('post', execute, 'root').send(confirm)).status).toBe(409);
  await db.query(
    "INSERT INTO school_exports(school_id,requested_by,format,status,snapshot_at,completed_at) VALUES($1,$2,'JSON','COMPLETED',now()-interval '4 days',now())",
    [f.schoolA, f.admin],
  );
  expect((await call('post', execute, 'root').send(confirm)).status).toBe(409);
  await db.query('UPDATE school_exports SET snapshot_at=now() WHERE school_id=$1', [f.schoolA]);
  expect(
    (
      await call('post', execute.replace(f.schoolA, f.schoolB), 'root').send({
        ...confirm,
        school_name: 'Test School B',
      })
    ).status,
  ).toBe(404);
  expect((await call('post', execute, 'root', false).send(confirm)).status).toBe(403);
  expect((await call('post', execute, 'root').send(confirm)).status).toBe(202);
  expect((await call('post', execute, 'root').send(confirm)).status).toBe(202);
  await expect(
    transaction(pools.api, { schoolId: f.schoolA, userId: f.admin }, (tx) =>
      tx.query('SELECT app.erase_school($1,$2)', [job, crypto.randomUUID()]),
    ),
  ).rejects.toThrow('permission denied');

  const files = new Set([
    ...Array.from(
      { length: 103 },
      (_, index) => `${f.schoolA}/profiles/folder/${String(index).padStart(3, '0')}.jpg`,
    ),
    f.schoolB + '/other.pdf',
  ]);
  let fail = true;
  let removals = 0;
  const storage = {
    storage: {
      from: (bucket: string) => {
        expect(bucket).toBe('school-documents');
        return {
          list: async (prefix: string, { limit, offset }: { limit: number; offset: number }) => {
            const entries = new Map<string, string | null>();
            for (const file of files) {
              if (!file.startsWith(prefix + '/')) continue;
              const [name, nested] = file.slice(prefix.length + 1).split('/');
              entries.set(name, nested ? null : file);
            }
            return {
              data: [...entries]
                .sort(([a], [b]) => a.localeCompare(b))
                .slice(offset, offset + limit)
                .map(([name, id]) => ({ id, name })),
              error: null,
            };
          },
          remove: async (paths: string[]) => {
            if (++removals === 2 && fail) return { error: { message: 'Temporary outage' } };
            for (const file of paths) files.delete(file);
            return { error: null };
          },
        };
      },
    },
  } as unknown as SupabaseClient;
  await purgeApprovedSchool(pools.worker, f.schoolA, storage);
  const stalled = (
    await db.query<{ last_error: string; irreversible_at: Date }>(
      'SELECT last_error,irreversible_at FROM school_offboarding WHERE id=$1',
      [job],
    )
  ).rows[0];
  expect(stalled.last_error).toBe('STORAGE_PURGE_FAILED');
  expect(stalled.irreversible_at).toBeTruthy();
  expect([...files].filter((path) => path.startsWith(f.schoolA + '/'))).toHaveLength(3);
  expect(
    (
      await call('post', `/platform/offboarding/${job}/hold`, 'root').send({
        enabled: true,
        reason: 'Too late to place this hold.',
        policy_ref: body.policy_ref,
      })
    ).status,
  ).toBe(409);
  expect((await db.query('SELECT id FROM schools WHERE id=$1', [f.schoolA])).rows).toHaveLength(1);

  fail = false;
  // Reset only the disposable fixture's retry clock.
  await db.exec('ALTER TABLE school_offboarding DISABLE TRIGGER touch');
  await db.query(
    "UPDATE school_offboarding SET updated_at=now()-interval '2 minutes' WHERE id=$1",
    [job],
  );
  await db.exec('ALTER TABLE school_offboarding ENABLE TRIGGER touch');
  await purgeApprovedSchool(pools.worker, f.schoolA, storage);
  const leftover = (await db.query('SELECT last_error FROM school_offboarding WHERE id=$1', [job]))
    .rows;
  expect(leftover, JSON.stringify(leftover)).toHaveLength(0);
  const { relations } = (
    await db.query<{ relations: string[] }>('SELECT app.school_erasure_relations() AS relations')
  ).rows[0];
  for (const table of relations) {
    expect(table).toMatch(/^[a-z_]+$/);
    expect(
      (await db.query(`SELECT 1 FROM public.${table} WHERE school_id=$1 LIMIT 1`, [f.schoolA]))
        .rows,
      table,
    ).toEqual([]);
  }
  expect([...files]).toEqual([f.schoolB + '/other.pdf']);
  expect(
    (await db.query('SELECT id FROM schools WHERE id=$1 OR id=$2', [f.schoolA, f.schoolB])).rows,
  ).toEqual([{ id: f.schoolB }]);
  expect(
    (await db.query('SELECT id FROM students WHERE id=$1', [f.foreignStudent])).rows,
  ).toHaveLength(1);
  expect(
    (await db.query('SELECT id FROM auth.users WHERE id=$1 OR id=$2', [f.admin, f.teacher])).rows,
  ).toEqual([{ id: f.teacher }]);
  expect(
    (await db.query('SELECT id FROM auth.sessions WHERE user_id=$1', [f.admin])).rows,
  ).toHaveLength(0);
  expect((await db.query('SELECT id FROM public.users WHERE id=$1', [f.admin])).rows).toEqual([]);
  expect(
    (await db.query('SELECT id FROM auth.mfa_factors WHERE user_id=$1', [f.admin])).rows,
  ).toEqual([]);
  expect((await db.query('SELECT * FROM auth.users WHERE id=$1', [f.teacher])).rows).toEqual(
    sharedIdentity,
  );
  expect(
    (
      await db.query('SELECT * FROM school_memberships WHERE school_id=$1 AND user_id=$2', [
        f.schoolB,
        f.teacher,
      ])
    ).rows,
  ).toEqual(sharedMembership);
  expect((await db.query('SELECT id FROM auth.sessions WHERE id=$1', [f.teacher])).rows).toEqual([
    { id: f.teacher },
  ]);
  expect(
    (await db.query('SELECT token_hash FROM app.push_endpoint_owners ORDER BY token_hash')).rows,
  ).toEqual([{ token_hash: 'b'.repeat(64) }]);
  const stale = await call('get', '/me', 'teacher');
  expect(stale.status).toBe(404);
  expect(stale.body.error.code).toBe('SCHOOL_CONTEXT_UNAVAILABLE');
  expect(stale.headers['cache-control']).toBe('no-store');
  const after = await call('get', '/me', 'teacher', true, '');
  expect(after.status).toBe(200);
  expect(after.body.memberships.map((m: { school_id: string }) => m.school_id)).toEqual([
    f.schoolB,
  ]);
  expect(after.body.school.school_id).toBe(f.schoolB);
  expect((await call('get', '/school-profile', 'teacher', true, f.schoolB)).status).toBe(200);
  expect((await call('get', '/school-profile', 'teacher')).status).toBe(404);
  const oldDownload = signedDownload(
    'ab'.repeat(32),
    `/reports/${crypto.randomUUID()}/file`,
    f.teacher,
    f.schoolA,
  );
  expect((await call('get', oldDownload.url, 'teacher')).status).toBe(404);
  expect((await call('get', oldDownload.url, 'teacher', true, f.schoolB)).status).toBe(403);
  expect(
    (
      await call('post', `/invitations/${oldInvitation}/respond`, 'teacher', true, '').send({
        accept: true,
      })
    ).status,
  ).toBe(404);
  expect((await db.query('SELECT token FROM auth.refresh_tokens ORDER BY token')).rows).toEqual([
    { token: 'shared-school-refresh' },
  ]);
  expect((await call('get', '/me', 'admin')).status).toBe(403);
  expect((await call('get', `/platform/schools/${f.schoolA}/profile`, 'root')).status).toBe(404);
  const search = await call('get', '/platform/schools?search=Test%20School%20A', 'root');
  expect(search.status).toBe(200);
  expect(search.body.data).toEqual([]);
  const again = await call(
    'post',
    `/platform/schools/${f.schoolB}/administrator-invitation`,
    'root',
  ).send({
    email,
    full_name: 'New school account',
  });
  expect(again.status, JSON.stringify(again.body)).toBe(201);
  expect(registeredAgain).not.toBe(f.admin);
  await db.query('UPDATE auth.users SET email_confirmed_at=now() WHERE id=$1', [registeredAgain]);
  const invitation = await call('get', '/invitations/pending', 'registered', true, '');
  expect(invitation.body.data.map((entry: { school_id: string }) => entry.school_id)).toEqual([
    f.schoolB,
  ]);
  const accepted = await call(
    'post',
    `/invitations/${again.body.id}/respond`,
    'registered',
    true,
    '',
  ).send({ accept: true });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  expect(
    (await call('get', '/me', 'registered', true, '')).body.memberships.map(
      (m: { school_id: string }) => m.school_id,
    ),
  ).toEqual([f.schoolB]);
  const log = (await call('get', '/platform/audit', 'root')).body.data.find(
    (entry: { entity_id: string }) => entry.entity_id === job,
  );
  expect(log.after).toMatchObject({
    school_id: f.schoolA,
    approved_by: f.admin,
    initiated_by: root,
    executed_by: root,
  });
});
