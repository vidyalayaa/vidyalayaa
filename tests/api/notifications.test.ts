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
let financeLogin = 0;
const platformUser = crypto.randomUUID();
const platformToken =
  'fixture.' +
  Buffer.from(
    JSON.stringify({
      sub: platformUser,
      aal: 'aal2',
    }),
  ).toString('base64url') +
  '.fixture';
const call = (method: 'get' | 'post' | 'put', path: string, role = 'admin') =>
  request(app)
    [method]('/api/v1' + path)
    .set(
      'Authorization',
      'Bearer ' + fixtureBearer(role === 'finance' ? 'finance:' + financeLogin : role),
    )
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
  await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [
    platformUser,
    'platform-notify@example.invalid',
  ]);
  await db.query("INSERT INTO platform_staff(user_id,platform_role) VALUES($1,'SUPER_ADMIN')", [
    platformUser,
  ]);
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
              ['finance:' + financeLogin]: finance,
              [platformToken]: platformUser,
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
  financeLogin++;
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
  financeLogin++;
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

it('schedules a Super Admin notification for one school, delivers when due, and cancels pending messages', async () => {
  const recipient = crypto.randomUUID();
  await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [
    recipient,
    'scheduled-recipient@example.invalid',
  ]);
  await db.query(
    "INSERT INTO school_memberships(school_id,user_id,role_id,status) SELECT $1,$2,id,'ACTIVE' FROM roles WHERE code='student'",
    [f.schoolB, recipient],
  );
  await db.query(
    "INSERT INTO subscriptions(school_id,plan_id,status,current_period_end) SELECT $1,plan_id,'ACTIVE',now()+interval '1 year' FROM subscriptions WHERE school_id=$2 LIMIT 1",
    [f.schoolB, f.schoolA],
  );
  const token = 'scheduled-platform-push-token';
  await db.query(
    "INSERT INTO push_tokens(school_id,user_id,token_hash,token_encrypted,platform) VALUES($1,$2,$3,$4,'WEB')",
    [f.schoolB, recipient, 'platform-notification-test', encrypt(token, key)],
  );
  const platform = (method: 'get' | 'post', path = '') =>
    request(app)
      [method]('/api/v1/platform/notifications' + path)
      .set('Authorization', 'Bearer ' + fixtureBearer(platformToken));
  const job = {
    school_id: f.schoolB,
    title: 'Scheduled platform test',
    body: 'Message for this school',
    scheduled_at: new Date(Date.now() + 8000).toISOString(),
  };
  const retry = crypto.randomUUID();
  expect(
    (await call('post', '/platform/notifications').set('Idempotency-Key', retry).send(job)).status,
  ).toBe(403);
  expect(
    (
      await platform('post')
        .set('Idempotency-Key', crypto.randomUUID())
        .send({ ...job, scheduled_at: '2020-01-01T00:00:00Z' })
    ).body.error.code,
  ).toBe('PLATFORM_NOTIFICATION_TIME');
  const queued = await platform('post').set('Idempotency-Key', retry).send(job);
  expect(queued.status, JSON.stringify(queued.body)).toBe(202);
  const id = queued.body.id;
  expect((await platform('post').set('Idempotency-Key', retry).send(job)).body.id).toBe(id);
  expect(
    (
      await platform('post')
        .set('Idempotency-Key', retry)
        .send({ ...job, body: 'Changed' })
    ).status,
  ).toBe(409);
  expect((await platform('get')).body.data).toContainEqual(
    expect.objectContaining({ id, status: 'SCHEDULED', recipients: 2 }),
  );
  const visible = (schoolId: string, userId: string, oid = id) =>
    transaction(
      pools.api,
      { schoolId, userId },
      (tx) => tx.query('SELECT id FROM notification_outbox WHERE id=$1', [oid]),
      true,
    );
  expect((await visible(f.schoolB, recipient)).rows).toHaveLength(0);
  expect((await visible(f.schoolA, f.studentUser)).rows).toHaveLength(0);
  expect(
    (
      await db.query('SELECT school_id FROM notification_recipient_targets WHERE outbox_id=$1', [
        id,
      ])
    ).rows,
  ).toEqual([{ school_id: f.schoolB }, { school_id: f.schoolB }]);

  const delivery = vi.spyOn(providers, 'deliver').mockResolvedValue('scheduled-test-receipt');
  try {
    await drainOutbox(pools.worker, f.schoolB, key);
    expect(delivery).not.toHaveBeenCalled();
    const cancelled = await platform('post')
      .set('Idempotency-Key', crypto.randomUUID())
      .send({
        ...job,
        title: 'Cancelled platform test',
        scheduled_at: new Date(Date.now() + 3600000).toISOString(),
      });
    expect(cancelled.status).toBe(202);
    expect((await platform('post', '/' + cancelled.body.id + '/cancel')).status).toBe(204);
    expect((await platform('get')).body.data).toContainEqual(
      expect.objectContaining({ id: cancelled.body.id, status: 'CANCELLED' }),
    );
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, Date.parse(job.scheduled_at) - Date.now() + 100)),
    );
    expect((await visible(f.schoolB, recipient)).rows).toHaveLength(1);
    await drainOutbox(pools.worker, f.schoolB, key);
    expect(delivery.mock.calls.some((args) => args[0] === 'PUSH' && args[1] === token)).toBe(true);
    expect((await platform('get')).body.data).toContainEqual(
      expect.objectContaining({ id, status: 'COMPLETED', sent: 1 }),
    );
    expect((await platform('post', '/' + id + '/cancel')).status).toBe(409);
    const immediate = await platform('post')
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ ...job, title: 'Immediate platform test', scheduled_at: null });
    expect(immediate.status).toBe(202);
    expect((await platform('get')).body.data).toContainEqual(
      expect.objectContaining({ id: immediate.body.id, status: 'QUEUED' }),
    );
  } finally {
    delivery.mockRestore();
  }
});

it('queues a daily Super Admin notification once per local day and stops future runs', async () => {
  const {
    rows: [clock],
  } = await db.query<{ local_time: string; expected: string }>(
    `SELECT to_char(t,'HH24:MI') AS local_time,
      ((t::date+1+date_trunc('minute',t)::time) AT TIME ZONE 'Asia/Kolkata')::text AS expected
     FROM (SELECT now() AT TIME ZONE 'Asia/Kolkata' AS t) local_clock`,
  );
  const body = {
    school_id: f.schoolA,
    title: 'Daily platform test',
    body: 'Bring your school diary.',
    local_time: clock.local_time,
  };
  const retry = crypto.randomUUID();
  const path = '/api/v1/platform/notifications/daily';
  const platform = (method: 'get' | 'post', suffix = '') =>
    request(app)
      [method](path + suffix)
      .set('Authorization', 'Bearer ' + fixtureBearer(platformToken));
  const schedule = (data = body) => platform('post').set('Idempotency-Key', retry).send(data);
  expect((await call('get', '/platform/notifications/daily', 'student')).status).toBe(403);
  expect(
    (await call('post', '/platform/notifications/daily').set('Idempotency-Key', retry).send(body))
      .status,
  ).toBe(403);
  expect((await schedule({ ...body, local_time: '24:00' })).status).toBe(422);
  const created = await schedule();
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.id;
  expect((await schedule()).body.id).toBe(id);
  expect((await schedule({ ...body, body: 'Different text' })).status).toBe(409);
  const list = async () => (await platform('get')).body.data;
  const next = (await list()).find((row: { id: string }) => row.id === id);
  expect(next).toMatchObject({
    status: 'ACTIVE',
    timezone: 'Asia/Kolkata',
    local_time: body.local_time,
  });
  expect(Date.parse(next.next_run_at)).toBe(Date.parse(clock.expected));

  const occurrences = async () =>
    (
      await db.query('SELECT id,school_id FROM notification_outbox WHERE dedupe_key LIKE $1', [
        'PLATFORM_NOTIFY:DAILY:' + id + ':%',
      ])
    ).rows;
  const run = (schoolId: string) =>
    transaction(pools.worker, { schoolId, actorType: 'SYSTEM' }, (tx) =>
      tx.query('SELECT app.enqueue_due_platform_daily_notifications()'),
    );
  await run(f.schoolA);
  expect(await occurrences()).toHaveLength(0);
  // A worker resumed after downtime. It may queue today's occurrence, once.
  await db.query(
    "UPDATE app.platform_daily_notifications SET next_run_at=now()-interval '3 days' WHERE id=$1",
    [id],
  );
  await run(f.schoolB);
  expect(await occurrences()).toHaveLength(0);
  await Promise.all([run(f.schoolA), run(f.schoolA)]);
  const queued = await occurrences();
  expect(queued).toEqual([{ id: expect.any(String), school_id: f.schoolA }]);
  expect(
    (
      await db.query('SELECT user_id FROM notification_recipient_targets WHERE outbox_id=$1', [
        (queued[0] as { id: string }).id,
      ])
    ).rows,
  ).toContainEqual({ user_id: f.parent });
  expect(Date.parse((await list()).find((row: { id: string }) => row.id === id).next_run_at)).toBe(
    Date.parse(clock.expected),
  );
  expect((await call('post', '/platform/notifications/daily/' + id + '/cancel')).status).toBe(403);
  expect((await platform('post', '/' + id + '/cancel')).status).toBe(204);
  expect(await list()).toContainEqual(
    expect.objectContaining({ id, status: 'CANCELLED', next_run_at: null }),
  );
  await run(f.schoolA);
  expect(await occurrences()).toEqual(queued);
});
