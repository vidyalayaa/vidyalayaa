import { fixtureBearer, withProviderSessions } from '../helpers/provider-sessions.js';
import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import request from 'supertest';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { portableDatabase, poolAdapters, fixture } from '../helpers/database.js';
import { createApp } from '../../apps/api/src/app.js';
import type { Config } from '../../apps/api/src/lib/config.js';
import { transaction } from '../../apps/api/src/lib/db.js';
import { processEvent } from '../../apps/api/src/modules/attendance/service.js';
import { reconcileEvents } from '../../apps/worker/src/reconcile.js';
const captured = vi.hoisted(() => [] as unknown[]);
vi.mock('../../apps/api/src/lib/monitoring.js', () => ({
  captureFailure: (e: unknown) => captured.push(e),
}));
let db: PGlite,
  pools: ReturnType<typeof poolAdapters>,
  f: Awaited<ReturnType<typeof fixture>>,
  app: ReturnType<typeof createApp>,
  root: string,
  rootToken: string;
beforeAll(async () => {
  db = await portableDatabase();
  pools = poolAdapters(db);
  f = await fixture(db);
  root = crypto.randomUUID();
  await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [
    root,
    'operations@example.invalid',
  ]);
  await db.query("INSERT INTO platform_staff(user_id,platform_role) VALUES($1,'SUPER_ADMIN')", [
    root,
  ]);
  rootToken =
    'test.' + Buffer.from(JSON.stringify({ aal: 'aal2' })).toString('base64url') + '.fixture';
  const auth = {
    auth: {
      getUser: async (token: string) => ({
        data: {
          user: {
            id:
              token === rootToken
                ? root
                : {
                    admin: f.admin,
                    parent: f.parent,
                    principal: f.principal,
                    student: f.studentUser,
                  }[token as 'admin'],
          },
        },
        error: null,
      }),
    },
  } as unknown as SupabaseClient;
  app = createApp(
    {
      NODE_ENV: 'test',
      PORT: 4000,
      WEB_ORIGINS: 'http://localhost:5173',
      TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32),
      TRUST_PROXY_HOPS: 0,
    } as Config,
    { ...pools, supabase: withProviderSessions(db, auth) },
  );
});
afterAll(async () => db.close());
const call = (method: 'get' | 'post' | 'patch' | 'put', path: string, role = 'admin') =>
  request(app)
    [method]('/api/v1' + path)
    .set('Authorization', 'Bearer ' + fixtureBearer(role))
    .set('X-School-Id', role === rootToken ? '' : f.schoolA);
it('keeps manual payment references in the privileged audit and rejects school-side billing changes', async () => {
  const body = {
    plan_code: 'PROFESSIONAL',
    status: 'ACTIVE',
    current_period_end: new Date(Date.now() + 86400000).toISOString(),
    reason: 'Manual contract reviewed',
    billing_ref: 'INVOICE-ISOLATED-TEST',
  };
  expect(
    (await call('patch', `/platform/schools/${f.schoolA}/subscription`, 'admin').send(body)).status,
  ).toBe(403);
  const result = await call('patch', `/platform/schools/${f.schoolA}/subscription`, rootToken).send(
    body,
  );
  expect(captured).toEqual([]);
  expect(result.status).toBe(200);
  expect(result.body.billing_ref).toBe(body.billing_ref);
  const audit = (
    await db.query<{ after: { reason: string; billing_ref: string } }>(
      "SELECT after FROM audit_logs WHERE school_id=$1 AND action='subscription.manual_change'",
      [f.schoolA],
    )
  ).rows[0];
  expect(audit.after.reason).toBe(body.reason);
  expect(audit.after.billing_ref).toBe(body.billing_ref);
});
it('restricts support intake to school administrators and requires platform authority to respond', async () => {
  const body = {
    subject: 'Reader configuration help',
    category: 'DEVICE',
    description: 'Need help configuring the gate reader.',
  };
  expect((await call('post', '/support-requests', 'parent').send(body)).status).toBe(403);
  const key = crypto.randomUUID(),
    created = await call('post', '/support-requests').set('Idempotency-Key', key).send(body);
  expect(created.status).toBe(201);
  expect(
    (await call('post', '/support-requests').set('Idempotency-Key', key).send(body)).body.id,
  ).toBe(created.body.id);
  expect((await call('get', '/support-requests', 'principal')).status).toBe(403);
  const response = { status: 'RESOLVED', response: 'Configuration guide supplied.' };
  expect(
    (await call('patch', `/platform/support-requests/${created.body.id}`, 'admin').send(response))
      .status,
  ).toBe(403);
  expect(
    (await call('patch', `/platform/support-requests/${created.body.id}`, rootToken).send(response))
      .status,
  ).toBe(204);
  expect((await call('get', '/support-requests')).body.data[0].response).toBe(response.response);
  expect((await call('get', '/platform/support-requests', rootToken)).body.data).toHaveLength(1);
});
it('keeps privacy choices owned by the parent and campus views limited to explicit same-group memberships', async () => {
  expect(
    (await call('put', '/profile/preferences', 'parent').send({ no_names_on_lock_screen: false }))
      .status,
  ).toBe(200);
  expect((await call('get', '/profile/preferences', 'parent')).body.no_names_on_lock_screen).toBe(
    false,
  );
  expect(
    (await call('put', '/profile/preferences', 'student').send({ no_names_on_lock_screen: false }))
      .status,
  ).toBe(403);
  await db.query(
    "INSERT INTO school_memberships(school_id,user_id,role_id,status) SELECT $1,$2,id,'ACTIVE' FROM roles WHERE code='school_admin'",
    [f.schoolB, f.admin],
  );
  const before = await call('get', '/organization/campuses');
  expect(before.body.data.map((x: { school_id: string }) => x.school_id)).toEqual([f.schoolA]);
  const org = (
    await db.query<{ id: string }>(
      "INSERT INTO organizations(name) VALUES('Fixture campuses') RETURNING id",
    )
  ).rows[0].id;
  await db.query('UPDATE schools SET organization_id=$1 WHERE id IN ($2,$3)', [
    org,
    f.schoolA,
    f.schoolB,
  ]);
  await db.query(
    "UPDATE subscriptions SET plan_id=(SELECT id FROM subscription_plans WHERE code='ENTERPRISE') WHERE school_id=$1",
    [f.schoolA],
  );
  expect((await call('get', '/organization/campuses')).body.data).toHaveLength(2);
  await db.query(
    "INSERT INTO school_memberships(school_id,user_id,role_id,status) SELECT $1,$2,id,'ACTIVE' FROM roles WHERE code='school_admin'",
    [f.schoolB, root],
  );
  await db.query(
    "UPDATE school_memberships SET status='SUSPENDED' WHERE school_id=$1 AND user_id=$2",
    [f.schoolB, f.admin],
  );
  expect((await call('get', '/organization/campuses')).body.data).toHaveLength(1);
});
it('shares limiter counters across runtime pools without exposing the private bucket table', async () => {
  const key = '11'.repeat(32);
  expect(
    (await pools.api.query('SELECT app.take_http_token($1,2,60) AS wait', [key])).rows[0].wait,
  ).toBe(0);
  expect(
    (await pools.device.query('SELECT app.take_http_token($1,2,60) AS wait', [key])).rows[0].wait,
  ).toBe(0);
  expect(
    (await pools.api.query('SELECT app.take_http_token($1,2,60) AS wait', [key])).rows[0].wait,
  ).toBeGreaterThan(0);
  await expect(pools.api.query('SELECT * FROM app.http_rate_buckets')).rejects.toThrow(
    'permission denied',
  );
});
it('reconciles the review queue without accepting an untrusted timestamp or rewriting raw evidence', async () => {
  const eventId = crypto.randomUUID(),
    future = new Date(Date.now() + 2 * 86400000).toISOString();
  await processEvent(
    pools.device,
    { id: f.deviceA, schoolId: f.schoolA, code: 'DEV_A', status: 'ACTIVE' },
    {
      event_id: eventId,
      device_id: 'DEV_A',
      card_uid: 'AABBCCDD',
      event_timestamp: future,
      time_source: 'RTC_SYNCED',
      sequence_number: 1,
      boot_id: crypto.randomUUID(),
      firmware_version: 'test',
    },
    'isolated',
  );
  const event = (
    await db.query<{ id: string; outcome: string }>(
      'SELECT id,outcome FROM attendance_events WHERE device_event_id=$1',
      [eventId],
    )
  ).rows[0];
  expect(['QUARANTINED_TIMESTAMP', 'STORED_PENDING_RULES']).toContain(event.outcome);
  const review = await call('post', `/attendance/events/${event.id}/reconcile`).send({
    reason: 'Review the isolated clock error',
  });
  expect(review.status).toBe(202);
  await reconcileEvents(pools.worker, f.schoolA);
  const status = (
    await db.query<{ status: string; result_code: string }>(
      'SELECT status,result_code FROM attendance_reconciliation_requests WHERE event_id=$1',
      [event.id],
    )
  ).rows[0];
  expect(captured).toEqual([]);
  expect(status.status).toBe('NEEDS_INFORMATION');
  expect(
    (
      await db.query<{ event_ts: Date }>('SELECT event_ts FROM attendance_events WHERE id=$1', [
        event.id,
      ])
    ).rows[0].event_ts.toISOString(),
  ).toBe(future);
});

it('bounds terminal exports by the approved date while keeping manual billing and support available', async () => {
  await db.query(
    "UPDATE subscriptions SET status='SUSPENDED',export_until=NULL WHERE school_id=$1",
    [f.schoolA],
  );
  expect((await call('get', '/exports')).body.error.code).toBe('EXPORT_WINDOW_REQUIRED');
  expect((await call('get', '/subscription')).status).toBe(200);
  expect((await call('get', '/support-requests')).status).toBe(200);
  await db.query(
    "UPDATE subscriptions SET export_until=now()+interval '1 day' WHERE school_id=$1",
    [f.schoolA],
  );
  expect((await call('get', '/exports')).status).toBe(200);
  expect((await call('get', '/exports', 'parent')).status).toBe(403);
  await db.query(
    "UPDATE subscriptions SET export_until=now()-interval '1 day' WHERE school_id=$1",
    [f.schoolA],
  );
  expect((await call('get', '/exports')).body.error.code).toBe('EXPORT_WINDOW_ENDED');
  await db.query("UPDATE subscriptions SET status='ACTIVE',export_until=NULL WHERE school_id=$1", [
    f.schoolA,
  ]);
});

it('exposes only approved before/after platform metadata, never arbitrary snapshot fields', async () => {
  const inserted = (
    await db.query<{ id: string }>(
      "INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,after) VALUES('USER',$1,'fixture.metadata','devices',$2) RETURNING id",
      [
        root,
        {
          status: 'REVOKED',
          reason: 'Isolated metadata redaction check',
          secret: 'fixture-only-sensitive-value',
          email: 'hidden@example.invalid',
        },
      ],
    )
  ).rows[0].id;
  const result = await call('get', '/platform/audit', rootToken);
  expect(result.status).toBe(200);
  const row = result.body.data.find((x: { id: string }) => x.id === inserted);
  expect(row.after).toEqual({ status: 'REVOKED', reason: 'Isolated metadata redaction check' });
  expect(JSON.stringify(result.body)).not.toContain('fixture-only-sensitive-value');
  expect(JSON.stringify(result.body)).not.toContain('hidden@example.invalid');
});
