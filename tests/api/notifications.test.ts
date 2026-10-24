import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import request from 'supertest';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { portableDatabase, poolAdapters, fixture } from '../helpers/database.js';
import { fixtureBearer, withProviderSessions } from '../helpers/provider-sessions.js';
import { createApp } from '../../apps/api/src/app.js';
import type { Config } from '../../apps/api/src/lib/config.js';
import { transaction } from '../../apps/api/src/lib/db.js';
import { drainOutbox } from '../../apps/worker/src/outbox.js';
import { encrypt } from '../../apps/api/src/lib/crypto.js';
import * as providers from '../../apps/worker/src/providers.js';
import { defaultNotificationSettings } from '@vidyalayaa/contracts';
let db: PGlite,
  f: Awaited<ReturnType<typeof fixture>>,
  pools: ReturnType<typeof poolAdapters>,
  app: ReturnType<typeof createApp>,
  foreign: string,
  finance: string;
const key = 'ab'.repeat(32);
const call = (method: 'get' | 'post' | 'put', path: string, role = 'admin') =>
  request(app)
    [method]('/api/v1' + path)
    .set('Authorization', 'Bearer ' + fixtureBearer(role))
    .set('X-School-Id', f.schoolA);
const payload = (ids: string[], title = 'School reminder') => ({
  title,
  body: 'Please bring your school diary tomorrow.',
  audience: 'MEMBERS',
  roles: [],
  user_ids: ids,
});
async function queue(ids: string[], title = 'School reminder') {
  const r = await call('post', '/notifications/messages')
    .set('Idempotency-Key', crypto.randomUUID())
    .send(payload(ids, title));
  expect(r.status, JSON.stringify(r.body)).toBe(202);
  return r.body.id as string;
}
beforeAll(async () => {
  db = await portableDatabase();
  f = await fixture(db);
  pools = poolAdapters(db);
  foreign = crypto.randomUUID();
  finance = crypto.randomUUID();
  for (const [uid, school, role] of [
    [foreign, f.schoolB, 'school_admin'],
    [finance, f.schoolA, 'finance_staff'],
  ]) {
    await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [
      uid,
      uid + '@example.invalid',
    ]);
    await db.query(
      "INSERT INTO school_memberships(school_id,user_id,role_id,status) SELECT $1,$2,id,'ACTIVE' FROM roles WHERE code=$3",
      [school, uid, role],
    );
  }
  const auth = {
    auth: {
      getUser: async (token: string) => ({
        data: {
          user: {
            id: {
              admin: f.admin,
              parent: f.parent,
              student: f.studentUser,
              teacher: f.teacher,
              principal: f.principal,
              finance,
            }[token],
          },
        },
        error: null,
      }),
    },
  } as unknown as SupabaseClient;
  app = createApp(
    {
      NODE_ENV: 'test',
      WEB_ORIGINS: 'http://localhost:5173',
      TOKEN_ENCRYPTION_KEY: key,
      TRUST_PROXY_HOPS: 0,
    } as Config,
    { ...pools, supabase: withProviderSessions(db, auth) },
  );
});
afterAll(async () => {
  vi.restoreAllMocks();
  await db?.close();
});
it('lists only active own-school accounts and push readiness without tokens', async () => {
  const r = await call('get', '/notifications/members');
  expect(r.status).toBe(200);
  expect(r.body.total).toBe(6);
  expect(JSON.stringify(r.body)).not.toContain(foreign);
  expect(r.body.data[0]).not.toHaveProperty('token_encrypted');
});
it.each(['principal', 'teacher', 'parent', 'student', 'finance'])(
  'denies %s school notification management at API and database',
  async (role) => {
    expect((await call('get', '/notifications/members', role)).status).toBe(403);
    expect(
      (
        await call('post', '/notifications/messages', role)
          .set('Idempotency-Key', crypto.randomUUID())
          .send(payload([f.parent]))
      ).status,
    ).toBe(403);
    const uid = {
      principal: f.principal,
      teacher: f.teacher,
      parent: f.parent,
      student: f.studentUser,
      finance,
    }[role]!;
    await expect(
      transaction(pools.api, { schoolId: f.schoolA, userId: uid }, (tx) =>
        tx.query('SELECT * FROM app.notification_members()'),
      ),
    ).rejects.toThrow();
    await expect(
      transaction(pools.api, { schoolId: f.schoolA, userId: uid }, (tx) =>
        tx.query('SELECT app.queue_custom_notification($1,$2,$3,$4,$5)', [
          'Title',
          'Message',
          [f.parent],
          crypto.randomUUID(),
          'a'.repeat(64),
        ]),
      ),
    ).rejects.toThrow();
  },
);
it('rejects foreign-school, malformed, and inactive recipients', async () => {
  expect((await call('post', '/notifications/preview').send(payload([foreign]))).status).toBe(422);
  expect(
    (
      await call('post', '/notifications/messages')
        .set('Idempotency-Key', crypto.randomUUID())
        .send(payload([foreign]))
    ).status,
  ).toBe(422);
  expect((await call('post', '/notifications/preview').send(payload([]))).status).toBe(422);
  await db.query("UPDATE school_memberships SET status='SUSPENDED' WHERE user_id=$1", [finance]);
  expect((await call('post', '/notifications/preview').send(payload([finance]))).status).toBe(422);
  await db.query("UPDATE school_memberships SET status='ACTIVE' WHERE user_id=$1", [finance]);
});
it('resolves whole-school and role targeting without duplicates', async () => {
  const all = await call('post', '/notifications/preview').send({
    ...payload([]),
    audience: 'ALL',
  });
  expect(all.body.recipients).toBe(6);
  const roles = await call('post', '/notifications/preview').send({
    ...payload([]),
    audience: 'ROLES',
    roles: ['teacher', 'parent'],
  });
  expect(roles.body.user_ids.sort()).toEqual([f.teacher, f.parent].sort());
});
it('queues durably once and rejects changed content under the same retry key', async () => {
  const retry = crypto.randomUUID(),
    b = payload([f.parent]);
  const first = await call('post', '/notifications/messages').set('Idempotency-Key', retry).send(b);
  expect(first.status, JSON.stringify(first.body)).toBe(202);
  const again = await call('post', '/notifications/messages').set('Idempotency-Key', retry).send(b);
  expect(again.body.id).toBe(first.body.id);
  expect(
    (
      await call('post', '/notifications/messages')
        .set('Idempotency-Key', retry)
        .send({ ...b, body: 'Changed' })
    ).status,
  ).toBeGreaterThanOrEqual(400);
  expect(
    (
      await db.query('SELECT * FROM notification_recipient_targets WHERE outbox_id=$1', [
        first.body.id,
      ])
    ).rows,
  ).toHaveLength(1);
});
it('shows custom notifications in only the selected members inbox before worker delivery', async () => {
  const title = 'Private parent update ' + crypto.randomUUID();
  await queue([f.parent], title);
  expect(JSON.stringify((await call('get', '/notifications', 'parent')).body)).toContain(title);
  for (const role of ['teacher', 'student', 'finance'])
    expect(JSON.stringify((await call('get', '/notifications', role)).body)).not.toContain(title);
  const visible = await transaction(
    pools.api,
    { schoolId: f.schoolA, userId: f.studentUser },
    (tx) => tx.query("SELECT * FROM notification_outbox WHERE payload->>'title'=$1", [title]),
  );
  expect(visible.rows).toHaveLength(0);
});
it('allows all school roles to register their own encrypted FCM endpoint', async () => {
  for (const role of ['admin', 'principal', 'teacher', 'parent', 'student', 'finance'])
    expect(
      (
        await call('post', '/push-tokens', role).send({
          token: 'fixture-browser-token-long-' + role,
          platform: 'WEB',
        })
      ).status,
    ).toBe(204);
});
it('sends custom FCM content to staff and honors parent lock-screen privacy', async () => {
  const send = vi.spyOn(providers, 'deliver').mockResolvedValue('FCM-accepted');
  const id = await queue([f.parent, f.teacher], 'Tomorrow’s meeting');
  await drainOutbox(pools.worker, f.schoolA, key);
  const rows = (await db.query('SELECT * FROM notification_deliveries WHERE outbox_id=$1', [id]))
    .rows;
  expect(rows.map((x) => x.status)).toEqual(['SENT', 'SENT']);
  expect(
    send.mock.calls.some(
      (x) =>
        x[2] === 'Please bring your school diary tomorrow.' && x[4]?.title === 'Tomorrow’s meeting',
    ),
  ).toBe(true);
  expect(
    send.mock.calls.some(
      (x) => x[2] === 'A school update is available. Open Vidyalayaa for details.',
    ),
  ).toBe(true);
  const before = send.mock.calls.length;
  await drainOutbox(pools.worker, f.schoolA, key);
  expect(send.mock.calls.length).toBe(before);
  send.mockRestore();
});
it('controls all school channels and kinds with optimistic concurrency', async () => {
  const initial = await call('get', '/notifications/settings');
  expect(initial.body.version).toBe(0);
  const saved = await call('put', '/notifications/settings').send({
    ...defaultNotificationSettings,
    enabled: false,
  });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  expect(saved.body.version).toBe(1);
  expect(
    (await call('put', '/notifications/settings').send(defaultNotificationSettings)).status,
  ).toBe(409);
  const send = vi.spyOn(providers, 'deliver').mockResolvedValue('unexpected');
  const id = await queue([f.teacher]);
  await drainOutbox(pools.worker, f.schoolA, key);
  expect(send).not.toHaveBeenCalled();
  expect(
    (
      await db.query('SELECT status,last_error FROM notification_deliveries WHERE outbox_id=$1', [
        id,
      ])
    ).rows[0],
  ).toMatchObject({ status: 'SUPPRESSED', last_error: 'SCHOOL_POLICY_DISABLED' });
  send.mockRestore();
  expect(
    (
      await call('put', '/notifications/settings').send({
        ...defaultNotificationSettings,
        version: 1,
      })
    ).status,
  ).toBe(200);
});
it('cancels queued work without sending and prevents later retry', async () => {
  const id = await queue([f.studentUser]);
  expect(
    (
      await call('post', `/notifications/messages/${id}/cancel`).send({
        reason: 'School requested cancellation',
      })
    ).status,
  ).toBe(204);
  const send = vi.spyOn(providers, 'deliver').mockResolvedValue('unexpected');
  await drainOutbox(pools.worker, f.schoolA, key);
  expect(send).not.toHaveBeenCalled();
  send.mockRestore();
  expect(
    (await db.query('SELECT cancelled_at,status FROM notification_outbox WHERE id=$1', [id]))
      .rows[0].cancelled_at,
  ).toBeTruthy();
});
it('rechecks membership just before delivery and blocks cross-school history', async () => {
  const id = await queue([finance]);
  await db.query("UPDATE school_memberships SET status='SUSPENDED' WHERE user_id=$1", [finance]);
  const send = vi.spyOn(providers, 'deliver').mockResolvedValue('unexpected');
  await drainOutbox(pools.worker, f.schoolA, key);
  expect(send).not.toHaveBeenCalled();
  send.mockRestore();
  expect(
    (
      await db.query('SELECT status,last_error FROM notification_deliveries WHERE outbox_id=$1', [
        id,
      ])
    ).rows[0],
  ).toMatchObject({ status: 'SUPPRESSED', last_error: 'RECIPIENT_ACCESS_CHANGED' });
  expect(
    (
      await transaction(pools.api, { schoolId: f.schoolB, userId: foreign }, (tx) =>
        tx.query('SELECT id FROM notification_outbox WHERE id=$1', [id]),
      )
    ).rows,
  ).toHaveLength(0);
  await db.query("UPDATE school_memberships SET status='ACTIVE' WHERE user_id=$1", [finance]);
});
it('reports missing device registration and retries after an endpoint is enabled', async () => {
  await db.query('UPDATE push_tokens SET is_active=false WHERE user_id=$1', [f.studentUser]);
  const id = await queue([f.studentUser]);
  await drainOutbox(pools.worker, f.schoolA, key);
  const d = (
    await db.query('SELECT id,status,last_error FROM notification_deliveries WHERE outbox_id=$1', [
      id,
    ])
  ).rows[0];
  expect(d).toMatchObject({ status: 'SUPPRESSED', last_error: 'NO_ENABLED_DEVICE' });
  await db.query(
    "INSERT INTO push_tokens(school_id,user_id,token_hash,token_encrypted,platform) VALUES($1,$2,$3,$4,'WEB')",
    [f.schoolA, f.studentUser, 'd'.repeat(64), encrypt('new-student-fixture-token', key)],
  );
  expect(
    (
      await call('post', `/notifications/${d.id}/retry`).send({
        reason: 'Student enabled browser notifications',
      })
    ).status,
  ).toBe(202);
  const send = vi.spyOn(providers, 'deliver').mockResolvedValue('FCM-retry');
  await drainOutbox(pools.worker, f.schoolA, key);
  expect(send).toHaveBeenCalledTimes(1);
  send.mockRestore();
  expect(
    (await db.query('SELECT status FROM notification_deliveries WHERE id=$1', [d.id])).rows[0]
      .status,
  ).toBe('SENT');
});
it('keeps tokens and recipient snapshots inaccessible to browser roles and unauthorized writes', async () => {
  for (const role of ['anon', 'authenticated'])
    expect(
      (
        await db.query(
          "SELECT has_table_privilege($1,'public.notification_recipient_targets','SELECT') AS allowed",
          [role],
        )
      ).rows[0].allowed,
    ).toBe(false);
  await expect(
    transaction(pools.api, { schoolId: f.schoolA, userId: f.teacher }, (tx) =>
      tx.query(
        "INSERT INTO notification_outbox(school_id,kind,dedupe_key,payload) VALUES($1,'CUSTOM','bypass','{}')",
        [f.schoolA],
      ),
    ),
  ).rejects.toThrow();
});

it('hides custom jobs from outdated workers rather than letting them broadcast to legacy parent recipients', async () => {
  const id = await queue([f.teacher]);
  const old = await transaction(
    pools.worker,
    { schoolId: f.schoolA, actorType: 'SYSTEM' },
    async (tx) => {
      await tx.query("SELECT set_config('app.notification_protocol','',true)");
      return tx.query('SELECT id FROM notification_outbox WHERE id=$1', [id]);
    },
  );
  expect(old.rows).toHaveLength(0);
  const upgraded = await transaction(
    pools.worker,
    { schoolId: f.schoolA, actorType: 'SYSTEM' },
    (tx) => tx.query('SELECT id FROM notification_outbox WHERE id=$1', [id]),
  );
  expect(upgraded.rows).toHaveLength(1);
});

it('enforces suspended-account inbox denial and School Admin settings control in database policies', async () => {
  await db.query("UPDATE school_memberships SET status='SUSPENDED' WHERE user_id=$1", [f.parent]);
  const denied = await transaction(
    pools.api,
    { schoolId: f.schoolA, userId: f.parent },
    async (tx) => ({
      targets: (await tx.query('SELECT id FROM notification_recipient_targets')).rows,
      notices: (await tx.query('SELECT id FROM notification_outbox')).rows,
    }),
  );
  expect(denied.targets).toEqual([]);
  expect(denied.notices).toEqual([]);
  await db.query("UPDATE school_memberships SET status='ACTIVE' WHERE user_id=$1", [f.parent]);
  for (const uid of [f.parent, f.studentUser, f.teacher, f.principal, finance]) {
    const result = await transaction(pools.api, { schoolId: f.schoolA, userId: uid }, (tx) =>
      tx.query(
        'UPDATE school_notification_settings SET enabled=false WHERE school_id=$1 RETURNING id',
        [f.schoolA],
      ),
    );
    expect(result.rows).toEqual([]);
  }
  expect(
    (
      await db.query('SELECT enabled FROM school_notification_settings WHERE school_id=$1', [
        f.schoolA,
      ])
    ).rows[0].enabled,
  ).toBe(true);
});

it('requires the checked queue function for inherited API login roles too', async () => {
  await db.exec(
    'CREATE ROLE notification_inherited_api NOLOGIN INHERIT;GRANT app_api TO notification_inherited_api',
  );
  try {
    await db.exec('BEGIN;SET LOCAL ROLE notification_inherited_api');
    await db.query("SELECT set_config('app.school_id',$1,true),set_config('app.user_id',$2,true)", [
      f.schoolA,
      f.teacher,
    ]);
    await expect(
      db.query(
        "INSERT INTO notification_outbox(school_id,kind,dedupe_key,payload) VALUES($1,'CUSTOM','inherited-bypass','{}')",
        [f.schoolA],
      ),
    ).rejects.toThrow(/authorized notification queue/);
  } finally {
    await db.exec('ROLLBACK');
  }
  try {
    await db.exec('BEGIN;SET LOCAL ROLE notification_inherited_api');
    await db.query("SELECT set_config('app.school_id',$1,true),set_config('app.user_id',$2,true)", [
      f.schoolA,
      f.admin,
    ]);
    const result = await db.query('SELECT app.queue_custom_notification($1,$2,$3,$4,$5) AS id', [
      'Checked queue',
      'School message',
      [f.parent],
      crypto.randomUUID(),
      'f'.repeat(64),
    ]);
    expect(result.rows[0].id).toBeTruthy();
  } finally {
    await db.exec('ROLLBACK');
  }
});
