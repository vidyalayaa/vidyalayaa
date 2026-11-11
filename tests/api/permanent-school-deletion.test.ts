import { afterAll, beforeAll, expect, it } from 'vitest';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createApp } from '../../apps/api/src/app.js';
import type { Config } from '../../apps/api/src/lib/config.js';
import { transaction } from '../../apps/api/src/lib/db.js';
import { purgeApprovedSchool } from '../../apps/worker/src/offboarding.js';
import { fixture, poolAdapters, portableDatabase } from '../helpers/database.js';
import { fixtureBearer, withProviderSessions } from '../helpers/provider-sessions.js';

let db: PGlite;
let pools: ReturnType<typeof poolAdapters>;
let app: ReturnType<typeof createApp>;
let f: Awaited<ReturnType<typeof fixture>>;
let root: string;

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
  const auth = {
    auth: {
      getUser: async (token: string) => {
        const [, , name] = token.split('.');
        const id = { root, admin: f.admin, principal: f.principal }[name];
        return {
          data: { user: id ? { id, factors: [{ status: 'verified' }] } : null },
          error: null,
        };
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

type TestActor = 'root' | 'admin' | 'principal';
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
): Promise<TestResponse>;
function call(
  method: 'post',
  path: string,
  name: TestActor,
  recent?: boolean,
): { send: (body: unknown) => Promise<TestResponse> };
function call(method: 'get' | 'post', path: string, name: TestActor, recent = true) {
  const timestamp = Math.floor(Date.now() / 1000) - (recent ? 1 : 3600);
  const claims = Buffer.from(
    JSON.stringify({ aal: 'aal2', amr: [{ method: 'totp', timestamp }] }),
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
      if (name !== 'root') req.headers['x-school-id'] = f.schoolA;
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

  const execute = path + '/' + job + '/execute';
  expect((await call('post', execute, 'root').send(confirm)).status).toBe(409);
  await db.query(
    "UPDATE school_offboarding SET export_until=now()-interval '2 days',delete_after=now()-interval '1 day' WHERE id=$1",
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
    "INSERT INTO school_exports(school_id,requested_by,format,status,snapshot_at,completed_at) VALUES($1,$2,'JSON','COMPLETED',now()-interval '1 day',now())",
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
