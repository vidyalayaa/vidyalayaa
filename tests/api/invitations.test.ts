import { beforeAll, afterAll, it, expect } from 'vitest';
import request from 'supertest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PGlite } from '@electric-sql/pglite';
import { portableDatabase, poolAdapters, fixture } from '../helpers/database.js';
import { createApp } from '../../apps/api/src/app.js';
import type { Config } from '../../apps/api/src/lib/config.js';
let db: PGlite,
  pools: ReturnType<typeof poolAdapters>,
  f: Awaited<ReturnType<typeof fixture>>,
  app: ReturnType<typeof createApp>;
const root = crypto.randomUUID(),
  known = new Set<string>([root]);
const enrolled = new Set<string>();
let mailed = 0,
  failMail = false;
const token = (id: string, aal = 'aal2') =>
  `test.${Buffer.from(JSON.stringify({ sub: id, aal })).toString('base64url')}.signature`;
async function identity(email: string, confirmed = true) {
  const id = crypto.randomUUID();
  known.add(id);
  await db.query('INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,$2,$3)', [
    id,
    email,
    confirmed ? new Date().toISOString() : null,
  ]);
  return id;
}
async function emptySchool() {
  const id = crypto.randomUUID();
  await db.query(
    "INSERT INTO schools(id,school_code,name,status) VALUES($1,$2,'New partner school','ACTIVE')",
    [id, id],
  );
  await db.query(
    "INSERT INTO subscriptions(school_id,plan_id,status,current_period_end) SELECT $1,id,'ACTIVE',now()+interval '1 year' FROM subscription_plans WHERE code='PROFESSIONAL'",
    [id],
  );
  return id;
}
function call(
  method: 'get' | 'post' | 'patch',
  path: string,
  user = root,
  school?: string,
  aal = 'aal2',
) {
  const r = request(app)
    [method]('/api/v1' + path)
    .set('Authorization', 'Bearer ' + token(user, aal));
  return school ? r.set('X-School-Id', school) : r;
}
beforeAll(async () => {
  db = await portableDatabase();
  pools = poolAdapters(db);
  f = await fixture(db);
  for (const id of [f.admin, f.teacher, f.principal, f.parent, f.studentUser]) known.add(id);
  await db.query(
    "INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,'platform@example.invalid',now())",
    [root],
  );
  await db.query("INSERT INTO platform_staff(user_id,platform_role) VALUES($1,'SUPER_ADMIN')", [
    root,
  ]);
  const auth = {
    auth: {
      getUser: async (value: string) => {
        let id = '';
        try {
          id = JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString()).sub;
        } catch {}
        return known.has(id)
          ? {
              data: {
                user: {
                  id,
                  factors: enrolled.has(id)
                    ? [{ id: 'verified-fixture-factor', status: 'verified', factor_type: 'totp' }]
                    : [],
                },
              },
              error: null,
            }
          : { data: { user: null }, error: { status: 401 } };
      },
      admin: {
        inviteUserByEmail: async (email: string) => {
          if (failMail)
            return {
              data: { user: null },
              error: { message: 'Fixture email provider unavailable' },
            };
          mailed++;
          const found = await db.query<{ id: string }>('SELECT id FROM auth.users WHERE email=$1', [
            email,
          ]);
          const id = found.rows[0]?.id || (await identity(email, false));
          return { data: { user: { id, email } }, error: null };
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
    { ...pools, supabase: auth },
  );
});
afterAll(async () => {
  await db?.close();
});

it('exposes aggregate platform health without granting student table access', async () => {
  expect((await call('get', '/platform/operations', root, undefined, 'aal1')).status).toBe(403);
  const result = await call('get', '/platform/operations');
  expect(result.status).toBe(200);
  expect(result.body.metrics.students).toBeGreaterThanOrEqual(1);
  expect(result.body.workers).toEqual([]);
  expect(JSON.stringify(result.body)).not.toContain('Test learner');
  expect(
    (
      await db.query<{ ok: boolean }>(
        "SELECT has_table_privilege('app_platform','students','SELECT') AS ok",
      )
    ).rows[0].ok,
  ).toBe(false);
});
it('requires enrolled MFA for every role before serving authenticated API data', async () => {
  for (const user of [root, f.admin, f.principal, f.teacher, f.parent, f.studentUser]) {
    enrolled.add(user);
    try {
      const denied = await call('get', '/me', user, undefined, 'aal1');
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe('MFA_REQUIRED');
      expect(
        (
          await call(
            'get',
            '/resources/students',
            user,
            user === root ? undefined : f.schoolA,
            'aal1',
          )
        ).status,
      ).toBe(403);
      expect((await call('get', '/me', user, undefined, 'aal2')).status).toBe(200);
    } finally {
      enrolled.delete(user);
    }
  }
});
it('updates plan settings with an audit trail and preserves omitted school overrides', async () => {
  const plan = (await db.query("SELECT * FROM subscription_plans WHERE code='PROFESSIONAL'"))
    .rows[0];
  const result = await call('patch', `/platform/plans/${plan.id}`).send({
    name: plan.name,
    features: plan.features,
    limits: { ...plan.limits, max_devices: 12 },
    is_active: true,
    reason: 'Test entitlement adjustment',
  });
  expect(result.status).toBe(200);
  expect(result.body.limits.max_devices).toBe(12);
  expect((await db.query("SELECT * FROM audit_logs WHERE action='plan.update'")).rows).toHaveLength(
    1,
  );
  await db.query(
    'UPDATE subscriptions SET limit_overrides=$2,grace_ends_at=$3 WHERE school_id=$1',
    [f.schoolA, JSON.stringify({ max_devices: 15 }), '2099-01-01T00:00:00Z'],
  );
  const sub = await call('patch', `/platform/schools/${f.schoolA}/subscription`).send({
    plan_code: 'PROFESSIONAL',
    status: 'ACTIVE',
    current_period_end: '2098-12-01T00:00:00Z',
    reason: 'Renew without changing overrides',
  });
  expect(sub.status).toBe(200);
  expect(sub.body.limit_overrides).toEqual({ max_devices: 15 });
  expect(sub.body.grace_ends_at).toContain('2099-01-01');
});
it('initializes a missing school subscription and updates the same record on retry', async () => {
  const input = {
    plan_code: 'PROFESSIONAL',
    status: 'ACTIVE',
    current_period_end: '2026-10-30T07:29:00Z',
    grace_ends_at: '2026-10-30T07:30:00Z',
    limit_overrides: {
      max_devices: 10,
      max_campuses: 1,
      max_students: 1000,
      report_retention_days: 120,
    },
    reason: 'Approved initial school subscription',
  };
  expect(
    (await db.query('SELECT id FROM subscriptions WHERE school_id=$1', [f.schoolB])).rows,
  ).toHaveLength(0);
  const path = `/platform/schools/${f.schoolB}/subscription`;
  expect((await call('patch', path, root, undefined, 'aal1').send(input)).status).toBe(403);
  expect((await call('patch', path, f.admin, f.schoolA).send(input)).status).toBe(403);
  const result = await call('patch', path).send(input);
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({
    school_id: f.schoolB,
    status: 'ACTIVE',
    limit_overrides: input.limit_overrides,
  });
  expect(new Date(result.body.current_period_end).toISOString()).toBe(
    new Date(input.current_period_end).toISOString(),
  );
  expect(new Date(result.body.grace_ends_at).toISOString()).toBe(
    new Date(input.grace_ends_at).toISOString(),
  );
  const event = (
    await db.query(
      'SELECT previous_status,new_status,reason,actor_id,subscription_id FROM subscription_events WHERE school_id=$1',
      [f.schoolB],
    )
  ).rows;
  expect(event).toEqual([
    {
      previous_status: null,
      new_status: 'ACTIVE',
      reason: input.reason,
      actor_id: root,
      subscription_id: result.body.id,
    },
  ]);
  const retry = await call('patch', path).send({
    ...input,
    limit_overrides: {},
    grace_ends_at: null,
  });
  expect(retry.status).toBe(200);
  expect(retry.body).toMatchObject({
    id: result.body.id,
    limit_overrides: {},
    grace_ends_at: null,
  });
  expect(
    (await db.query('SELECT id FROM subscriptions WHERE school_id=$1', [f.schoolB])).rows,
  ).toHaveLength(1);
});
it('rejects missing schools and invalid initial plans without creating subscriptions', async () => {
  const school = crypto.randomUUID();
  const input = {
    plan_code: 'BASIC',
    status: 'ACTIVE',
    current_period_end: '2099-01-01T00:00:00Z',
    reason: 'Initial subscription validation',
  };
  const path = `/platform/schools/${school}/subscription`;
  expect((await call('patch', path).send(input)).status).toBe(404);
  await db.query(
    "INSERT INTO schools(id,school_code,name,status) VALUES($1,$2,'Unconfigured school','ACTIVE')",
    [school, school],
  );
  expect(
    (
      await call('patch', path).send({
        ...input,
        plan_code: undefined,
        plan_id: crypto.randomUUID(),
      })
    ).status,
  ).toBe(422);
  expect(
    (await call('patch', path).send({ ...input, limit_overrides: { undefined_limit: 1 } })).status,
  ).toBe(422);
  await db.query("UPDATE subscription_plans SET is_active=false WHERE code='BASIC'");
  try {
    expect((await call('patch', path).send(input)).status).toBe(422);
    const create = await call('post', '/platform/schools').send({
      school_code: 'REJECT_INACTIVE',
      name: 'Rejected school',
      timezone: 'Asia/Kolkata',
      plan_code: 'BASIC',
      trial_ends_at: input.current_period_end,
    });
    expect(create.status).toBe(422);
    expect(
      (await db.query("SELECT id FROM schools WHERE school_code='REJECT_INACTIVE'")).rows,
    ).toHaveLength(0);
  } finally {
    await db.query("UPDATE subscription_plans SET is_active=true WHERE code='BASIC'");
  }
  expect(
    (await db.query('SELECT id FROM subscriptions WHERE school_id=$1', [school])).rows,
  ).toHaveLength(0);
  expect(
    (await db.query('SELECT id FROM subscription_events WHERE school_id=$1', [school])).rows,
  ).toHaveLength(0);
});
it('opens only approved support scope, audits reads and honors revocation on the next request', async () => {
  const grant = await call('post', '/platform/support-grants').send({
    school_id: f.schoolA,
    reason: 'Investigate isolated fixture record',
    ticket_ref: 'TEST-SUPPORT',
    scope: ['students'],
    minutes: 60,
  });
  expect(grant.status).toBe(201);
  expect((await call('get', `/platform/support-grants/${grant.body.id}/students`)).status).toBe(
    404,
  );
  expect(
    (
      await call('post', `/support-grants/${grant.body.id}/decision`, f.admin, f.schoolA).send({
        approve: true,
      })
    ).status,
  ).toBe(200);
  const read = await call('get', `/platform/support-grants/${grant.body.id}/students?page_size=1`);
  expect(read.status).toBe(200);
  expect(read.body.page_size).toBe(1);
  expect(read.body.total).toBeGreaterThan(0);
  expect(
    (await db.query('SELECT * FROM audit_logs WHERE support_grant_id=$1', [grant.body.id])).rows,
  ).toHaveLength(1);
  expect((await call('get', `/platform/support-grants/${grant.body.id}/fees`)).status).toBe(404);
  expect(
    (
      await call('post', `/support-grants/${grant.body.id}/decision`, f.admin, f.schoolA).send({
        approve: false,
      })
    ).status,
  ).toBe(200);
  expect((await call('get', `/platform/support-grants/${grant.body.id}/students`)).status).toBe(
    404,
  );
});

it('requires platform MFA and restricts bootstrap to the School Admin role', async () => {
  const sid = await emptySchool(),
    body = { email: 'denied@example.invalid', full_name: 'Denied person' };
  expect(
    (
      await call(
        'post',
        `/platform/schools/${sid}/administrator-invitation`,
        root,
        undefined,
        'aal1',
      ).send(body)
    ).status,
  ).toBe(403);
  expect(
    (
      await call(
        'post',
        `/platform/schools/${sid}/administrator-invitation`,
        f.admin,
        f.schoolA,
      ).send(body)
    ).status,
  ).toBe(403);
  expect(
    (
      await call('post', `/platform/schools/${sid}/administrator-invitation`).send({
        ...body,
        role: 'principal',
      })
    ).status,
  ).toBe(422);
  expect(
    (await call('post', `/platform/schools/${f.schoolA}/administrator-invitation`).send(body))
      .status,
  ).toBe(403);
  await expect(pools.platform.query('SELECT id FROM students')).rejects.toMatchObject({
    code: '42501',
  });
  await expect(pools.platform.query('SELECT id FROM school_memberships')).rejects.toMatchObject({
    code: '42501',
  });
});

it('invites the first administrator once and requires verified recipient acceptance', async () => {
  const sid = await emptySchool(),
    body = { email: 'first-admin@example.invalid', full_name: 'First administrator' },
    before = mailed;
  const sent = await call('post', `/platform/schools/${sid}/administrator-invitation`).send(body);
  expect(sent.status).toBe(201);
  expect(sent.body.status).toBe('SENT');
  expect(mailed).toBe(before + 1);
  const repeat = await call('post', `/platform/schools/${sid}/administrator-invitation`).send(body);
  expect(repeat.body.id).toBe(sent.body.id);
  expect(mailed).toBe(before + 1);
  expect(
    (
      await call('post', `/platform/schools/${sid}/administrator-invitation`).send({
        ...body,
        email: 'different@example.invalid',
      })
    ).status,
  ).toBe(403);
  const uid = (
    await db.query<{ id: string }>('SELECT id FROM auth.users WHERE email=$1', [body.email])
  ).rows[0].id;
  expect((await call('get', '/me', uid)).body.memberships).toEqual([]);
  expect((await call('get', '/invitations/pending', uid)).body.data).toEqual([]);
  expect(
    (await call('post', `/invitations/${sent.body.id}/respond`, uid).send({ accept: true })).status,
  ).toBe(404);
  await db.query('UPDATE auth.users SET email_confirmed_at=now() WHERE id=$1', [uid]);
  expect((await call('get', '/invitations/pending', uid)).body.data[0].school_id).toBe(sid);
  expect(
    (
      await call('post', `/invitations/${sent.body.id}/respond`, f.parent, f.schoolA).send({
        accept: true,
      })
    ).status,
  ).toBe(404);
  expect(
    (await call('post', `/invitations/${sent.body.id}/respond`, uid).send({ accept: true })).body
      .accepted,
  ).toBe(true);
  const me = await call('get', '/me', uid);
  expect(me.body.school.role).toBe('school_admin');
  expect(me.body.school.school_id).toBe(sid);
  expect(
    (
      await call('post', `/platform/schools/${sid}/administrator-invitation`).send({
        ...body,
        email: 'replacement@example.invalid',
      })
    ).status,
  ).toBe(403);
  expect(
    (await call('post', `/invitations/${sent.body.id}/respond`, uid, sid).send({ accept: true }))
      .status,
  ).toBe(404);
});

it('lets an existing identity accept another school without altering its previous role', async () => {
  const uid = await identity('existing-person@example.invalid'),
    before = mailed;
  await db.query(
    "INSERT INTO school_memberships(school_id,user_id,role_id) SELECT $1,$2,id FROM roles WHERE code='teacher'",
    [f.schoolB, uid],
  );
  const invited = await call('post', '/invitations', f.admin, f.schoolA).send({
    email: 'existing-person@example.invalid',
    full_name: 'Existing colleague',
    role: 'principal',
  });
  expect(invited.status).toBe(201);
  expect(invited.body.status).toBe('READY');
  expect(mailed).toBe(before);
  expect((await call('get', '/me', uid, f.schoolB)).body.memberships).toHaveLength(1);
  expect(
    (
      await call('post', `/invitations/${invited.body.id}/respond`, uid, f.schoolB).send({
        accept: true,
      })
    ).status,
  ).toBe(200);
  expect((await call('get', '/me', uid, f.schoolB)).body.school.role).toBe('teacher');
  expect((await call('get', '/me', uid, f.schoolA)).body.school.role).toBe('principal');
  expect((await call('get', '/me', uid, f.schoolA)).body.memberships).toHaveLength(2);
  expect(
    (
      await call('post', '/invitations', f.admin, f.schoolA).send({
        email: 'existing-person@example.invalid',
        full_name: 'Existing colleague',
        role: 'school_admin',
      })
    ).status,
  ).toBe(409);
});

it('records provider failures, retries safely and supports cancellation', async () => {
  const body = {
    email: 'retry-invite@example.invalid',
    full_name: 'Retry colleague',
    role: 'teacher',
  };
  failMail = true;
  expect((await call('post', '/invitations', f.admin, f.schoolA).send(body)).status).toBe(422);
  failMail = false;
  const list = await call('get', '/invitations', f.admin, f.schoolA);
  const failed = list.body.data.find((entry: { email: string }) => entry.email === body.email);
  expect(failed.status).toBe('FAILED');
  const retried = await call('post', `/invitations/${failed.id}/resend`, f.admin, f.schoolA).send(
    {},
  );
  expect(retried.status).toBe(200);
  expect(retried.body.id).toBe(failed.id);
  expect(
    (await call('post', `/invitations/${failed.id}/resend`, f.principal, f.schoolA).send({}))
      .status,
  ).toBe(403);
  expect(
    (await call('post', `/invitations/${failed.id}/cancel`, f.admin, f.schoolA).send({})).status,
  ).toBe(204);
  const row = (
    await db.query<{ status: string }>('SELECT status FROM school_invitations WHERE id=$1', [
      failed.id,
    ])
  ).rows[0];
  expect(row.status).toBe('REVOKED');
});

it('allows recipients to decline and prevents loss of the last active school administrator', async () => {
  const uid = await identity('decline@example.invalid');
  const invited = await call('post', '/invitations', f.admin, f.schoolA).send({
    email: 'decline@example.invalid',
    full_name: 'Declining colleague',
    role: 'parent',
  });
  expect(
    (await call('post', `/invitations/${invited.body.id}/respond`, uid).send({ accept: false }))
      .body.accepted,
  ).toBe(false);
  expect((await call('get', '/me', uid)).body.memberships).toEqual([]);
  // A status detour cannot bypass a recipient's decision.
  await db.query(
    "UPDATE school_memberships SET status='SUSPENDED' WHERE school_id=$1 AND user_id=$2",
    [f.schoolA, uid],
  );
  await expect(
    db.query("UPDATE school_memberships SET status='ACTIVE' WHERE school_id=$1 AND user_id=$2", [
      f.schoolA,
      uid,
    ]),
  ).rejects.toMatchObject({ code: '23514', message: 'INVITATION_PENDING' });
  await expect(
    db.query("UPDATE school_memberships SET status='SUSPENDED' WHERE school_id=$1 AND user_id=$2", [
      f.schoolA,
      f.admin,
    ]),
  ).rejects.toMatchObject({ code: '23514', message: 'LAST_SCHOOL_ADMIN' });
  expect((await call('get', '/me', f.admin, f.schoolA)).body.school.role).toBe('school_admin');
});
