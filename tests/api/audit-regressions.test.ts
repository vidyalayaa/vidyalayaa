import { fixtureBearer, withProviderSessions } from '../helpers/provider-sessions.js';
import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import request from 'supertest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PGlite } from '@electric-sql/pglite';
import { portableDatabase, poolAdapters, fixture } from '../helpers/database.js';
import { createApp } from '../../apps/api/src/app.js';
import type { Config } from '../../apps/api/src/lib/config.js';
import { drainOutbox } from '../../apps/worker/src/outbox.js';
import { hash } from '../../apps/api/src/lib/crypto.js';
import { resourceNames } from '@vidyalayaa/contracts';
import { definitions } from '../../apps/api/src/modules/school/resources.js';

vi.mock('../../apps/worker/src/providers.js', async (importActual) => ({
  ...(await importActual<typeof import('../../apps/worker/src/providers.js')>()),
  deliver: vi.fn(async () => 'isolated-test-provider-id'),
}));
let db: PGlite,
  f: Awaited<ReturnType<typeof fixture>>,
  pools: ReturnType<typeof poolAdapters>,
  app: ReturnType<typeof createApp>;
beforeAll(async () => {
  db = await portableDatabase();
  pools = poolAdapters(db);
  f = await fixture(db);
  const auth = {
    auth: {
      getUser: async (token: string) => {
        const id = {
          admin: f.admin,
          principal: f.principal,
          parent: f.parent,
          student: f.studentUser,
          teacher: f.teacher,
        }[token as 'admin'];
        return { data: { user: id ? { id } : null }, error: id ? null : { message: 'invalid' } };
      },
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
afterAll(async () => {
  await db.close();
});
const call = (method: 'get' | 'post' | 'patch', path: string, role = 'admin', school?: string) =>
  request(app)
    [method]('/api/v1' + path)
    .set('Authorization', 'Bearer ' + fixtureBearer(role))
    .set('X-School-Id', school || f.schoolA);

it('revokes an already generated school-wide PDF after Principal demotion', async () => {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO report_documents(id,school_id,kind,parameters,requested_by,status,storage_path,authorization_version,authorization_role,authorization_scope)
   SELECT $1,$2,'ATTENDANCE','{}',$3,'COMPLETED','private.pdf',access_version,'principal',app.report_scope_fingerprint($3) FROM schools WHERE id=$2`,
    [id, f.schoolA, f.principal],
  );
  // The fingerprint function deliberately uses tenant context, including for owner test setup.
  await db.exec(`SELECT set_config('app.school_id','${f.schoolA}',false)`);
  await db.query(
    'UPDATE report_documents SET authorization_scope=app.report_scope_fingerprint($1) WHERE id=$2',
    [f.principal, id],
  );
  expect((await call('get', `/reports/${id}/download`, 'principal')).status).toBe(200);
  await db.query(
    "UPDATE school_memberships SET role_id=(SELECT id FROM roles WHERE code='parent') WHERE school_id=$1 AND user_id=$2",
    [f.schoolA, f.principal],
  );
  expect((await call('get', `/reports/${id}/download`, 'principal')).status).toBe(404);
  await db.query(
    "UPDATE school_memberships SET role_id=(SELECT id FROM roles WHERE code='principal') WHERE school_id=$1 AND user_id=$2",
    [f.schoolA, f.principal],
  );
});

it('delivers STAFF publications only to active school staff, never linked parents', async () => {
  const r = await call('post', '/resources/announcements').send({
    audience: 'STAFF',
    title: 'Private staff test',
    body: 'Test only',
    published_at: new Date(Date.now() - 1000).toISOString(),
  });
  expect(r.status).toBe(201);
  await drainOutbox(pools.worker, f.schoolA, 'ab'.repeat(32));
  const results = await db.query<{
    parent_id: string | null;
    recipient_user_id: string;
    channel: string;
  }>(
    "SELECT d.parent_id,d.recipient_user_id,d.channel FROM notification_deliveries d JOIN notification_outbox o ON o.id=d.outbox_id WHERE o.payload->>'announcement_id'=$1",
    [r.body.id],
  );
  expect(results.rows.length).toBe(6);
  expect(results.rows.filter((x) => x.channel === 'EMAIL')).toHaveLength(3);
  expect(results.rows.filter((x) => x.channel === 'PUSH')).toHaveLength(3);
  expect(results.rows.every((x) => x.parent_id === null && x.recipient_user_id !== f.parent)).toBe(
    true,
  );
  expect((await call('get', '/notifications', 'parent')).body.data).toEqual([]);
});

it('queues draft publication once and waits for future publication', async () => {
  const draft = await call('post', '/resources/announcements').send({
    audience: 'PARENTS',
    title: 'Draft',
    body: 'Test only',
  });
  expect(draft.status).toBe(201);
  expect(
    (
      await call('patch', `/resources/announcements/${draft.body.id}`).send({
        published_at: new Date(Date.now() - 1000).toISOString(),
      })
    ).status,
  ).toBe(200);
  const future = new Date(Date.now() + 3600000).toISOString();
  const next = await call('post', '/resources/announcements').send({
    audience: 'SCHOOL',
    title: 'Scheduled',
    body: 'Scheduled test only',
    published_at: future,
  });
  expect(next.status).toBe(201);
  await drainOutbox(pools.worker, f.schoolA, 'ab'.repeat(32));
  const job = (
    await db.query<{ status: string; attempts: number; next_attempt_at: Date }>(
      "SELECT status,attempts,next_attempt_at FROM notification_outbox WHERE payload->>'announcement_id'=$1",
      [next.body.id],
    )
  ).rows[0];
  expect(job.attempts).toBe(0);
  expect(job.status).toBe('PENDING');
  expect(job.next_attempt_at.getTime()).toBeGreaterThanOrEqual(new Date(future).getTime());
  expect(
    (await call('get', '/resources/announcements', 'student')).body.data.some(
      (x: { id: string }) => x.id === draft.body.id,
    ),
  ).toBe(false);
});

it('enforces active-student quotas on reactivation', async () => {
  const id = crypto.randomUUID();
  await db.query(
    "INSERT INTO students(id,school_id,student_code,first_name,status) VALUES($1,$2,'INACTIVE','Quota test','WITHDRAWN')",
    [id, f.schoolA],
  );
  await db.query(
    "UPDATE subscriptions SET limit_overrides='{" + '"max_students":1' + "}' WHERE school_id=$1",
    [f.schoolA],
  );
  const r = await call('patch', `/resources/students/${id}`).send({ status: 'ACTIVE' });
  expect(r.status).toBe(409);
  expect(r.body.error.code).toBe('PLAN_LIMIT_REACHED');
  await db.query("UPDATE subscriptions SET limit_overrides='{}' WHERE school_id=$1", [f.schoolA]);
});

it('requires the one-time claim code before activation', async () => {
  const id = crypto.randomUUID(),
    code = 'CLAIM_' + id.slice(0, 8),
    secret = 'isolated-claim-code-123456';
  const location = (
    await db.query<{ location_id: string }>('SELECT location_id FROM devices WHERE id=$1', [
      f.deviceA,
    ])
  ).rows[0].location_id;
  await db.query(
    "INSERT INTO devices(id,school_id,device_code,name,status,claim_code_hash) VALUES($1,$2,$3,'Unclaimed','PROVISIONED',$4)",
    [id, f.schoolA, code, Buffer.from(hash(secret), 'hex')],
  );
  const bypass = await call('patch', `/devices/${id}`).send({
    name: 'Bypass',
    status: 'ACTIVE',
    location_id: location,
    reason: 'Test bypass prevented',
  });
  expect(bypass.status).toBe(409);
  expect(bypass.body.error.code).toBe('CLAIM_REQUIRED');
  const claim = await call('post', '/devices/claim').send({
    device_code: code,
    claim_code: secret,
    name: 'Claimed',
    location_id: location,
  });
  expect(claim.status).toBe(200);
});

it('checks the plan on direct material downloads', async () => {
  const id = crypto.randomUUID();
  await db.query(
    "INSERT INTO assignments(id,school_id,class_id,kind,title,storage_path,created_by) VALUES($1,$2,$3,'MATERIAL','Scoped test',$4,$5)",
    [id, f.schoolA, f.classId, `${f.schoolA}/materials/${f.classId}/test.pdf`, f.admin],
  );
  await db.query(
    "UPDATE subscriptions SET plan_id=(SELECT id FROM subscription_plans WHERE code='BASIC') WHERE school_id=$1",
    [f.schoolA],
  );
  const r = await call('get', `/materials/${id}/download`, 'parent');
  expect(r.status).toBe(403);
  expect(r.body.error.code).toBe('SUBSCRIPTION_FEATURE_UNAVAILABLE');
  await db.query(
    "UPDATE subscriptions SET plan_id=(SELECT id FROM subscription_plans WHERE code='PROFESSIONAL') WHERE school_id=$1",
    [f.schoolA],
  );
});

it('keeps one browser endpoint subscribed to both authorized schools and revokes all on logout', async () => {
  await db.query(
    "INSERT INTO school_memberships(school_id,user_id,role_id,status) SELECT $1,$2,id,'ACTIVE' FROM roles WHERE code='parent'",
    [f.schoolB, f.parent],
  );
  await db.query(
    "INSERT INTO subscriptions(school_id,plan_id,status,current_period_end) SELECT $1,id,'ACTIVE',now()+interval '30 days' FROM subscription_plans WHERE code='PROFESSIONAL'",
    [f.schoolB],
  );
  const token = 'isolated-multi-school-browser-token';
  expect(
    (await call('post', '/push-tokens', 'parent').send({ token, platform: 'WEB' })).status,
  ).toBe(204);
  expect(
    (await call('post', '/push-tokens', 'parent', f.schoolB).send({ token, platform: 'WEB' }))
      .status,
  ).toBe(204);
  expect(
    (await db.query('SELECT * FROM push_tokens WHERE token_hash=$1 AND is_active', [hash(token)]))
      .rows.length,
  ).toBe(2);
  const r = await request(app)
    .delete('/api/v1/push-tokens')
    .set('Authorization', 'Bearer ' + fixtureBearer('parent'))
    .set('X-School-Id', f.schoolA)
    .send({ token_hash: hash(token) });
  expect(r.status).toBe(204);
  expect(
    (await db.query('SELECT * FROM push_tokens WHERE token_hash=$1 AND is_active', [hash(token)]))
      .rows.length,
  ).toBe(0);
});

it('checks every resource read and denied write for all five school memberships', async () => {
  const foreign = crypto.randomUUID();
  for (const role of ['admin', 'principal', 'teacher', 'parent', 'student']) {
    const user = {
      admin: f.admin,
      principal: f.principal,
      teacher: f.teacher,
      parent: f.parent,
      student: f.studentUser,
    }[role as 'admin'];
    const permissions = (
      await db.query<{ code: string }>(
        'SELECT p.code FROM school_memberships m JOIN role_permissions rp ON rp.role_id=m.role_id JOIN permissions p ON p.id=rp.permission_id WHERE m.school_id=$1 AND m.user_id=$2',
        [f.schoolA, user],
      )
    ).rows.map((x) => x.code);
    for (const name of resourceNames) {
      const read = await call('get', `/resources/${name}/${foreign}`, role);
      expect(read.status, `${role} read ${name}`).toBe(
        role === 'teacher' &&
          ['classes', 'subjects', 'enrollments', 'school_holidays'].includes(name)
          ? 404
          : permissions.includes(definitions[name].read)
            ? 404
            : 403,
      );
      if (!definitions[name].write || !permissions.includes(definitions[name].write!)) {
        const write = await call('post', `/resources/${name}`, role).send({});
        expect(write.status, `${role} write ${name}`).toBe(403);
      }
    }
  }
});

it('validates complete imports without saving, then commits once under an idempotency key', async () => {
  const rows = [
    { student_code: 'IMPORT_A', first_name: 'Imported learner' },
    { student_code: 'IMPORT_B', first_name: 'Second learner' },
  ];
  const preview = await call('post', '/imports/students').send({ rows, validate_only: true });
  expect(preview.status).toBe(200);
  expect(preview.body.validated).toBe(2);
  expect(
    (
      await db.query(
        "SELECT id FROM students WHERE school_id=$1 AND student_code LIKE 'IMPORT_%'",
        [f.schoolA],
      )
    ).rows.length,
  ).toBe(0);
  const key = crypto.randomUUID();
  const commit = await call('post', '/imports/students')
    .set('Idempotency-Key', key)
    .send({ rows, validate_only: false });
  expect(commit.status).toBe(201);
  expect(commit.body.imported).toBe(2);
  const retry = await call('post', '/imports/students')
    .set('Idempotency-Key', key)
    .send({ rows, validate_only: false });
  expect(retry.status).toBe(201);
  expect(retry.body.imported).toBe(2);
  const invalid = await call('post', '/imports/students').send({
    rows: [
      { student_code: 'SHOULD_NOT_SAVE', first_name: 'Valid' },
      { student_code: 'IMPORT_A', first_name: 'Duplicate' },
    ],
    validate_only: false,
  });
  expect(invalid.status).toBe(422);
  expect(
    (
      await db.query(
        "SELECT id FROM students WHERE school_id=$1 AND student_code='SHOULD_NOT_SAVE'",
        [f.schoolA],
      )
    ).rows.length,
  ).toBe(0);
  expect(
    (await call('post', '/imports/students', 'principal').send({ rows, validate_only: true }))
      .status,
  ).toBe(403);
});

it('archives a timetable entry without deleting history and frees the conflicting slot', async () => {
  const teacher = (
    await db.query<{ id: string }>('SELECT id FROM teachers WHERE school_id=$1', [f.schoolA])
  ).rows[0].id;
  const body = {
    class_id: f.classId,
    teacher_id: teacher,
    subject_id: f.subject,
    weekday: 1,
    starts_at: '10:00',
    ends_at: '11:00',
  };
  const first = await call('post', '/resources/timetable_entries').send(body);
  expect(first.status).toBe(201);
  expect((await call('post', '/resources/timetable_entries').send(body)).status).toBe(409);
  expect(
    (
      await call('post', `/resources/timetable_entries/${first.body.id}/retire`).send({
        reason: 'Replace incorrect timetable entry',
      })
    ).status,
  ).toBe(204);
  expect((await call('get', `/resources/timetable_entries/${first.body.id}`)).status).toBe(404);
  expect(
    (await db.query('SELECT retired_at FROM timetable_entries WHERE id=$1', [first.body.id])).rows
      .length,
  ).toBe(1);
  expect((await call('post', '/resources/timetable_entries').send(body)).status).toBe(201);
});

it('limits family profile and history and restricts school security and full exports', async () => {
  const profile = await call('get', '/profile/family', 'parent');
  expect(profile.status).toBe(200);
  expect(profile.body.children.map((c: { id: string }) => c.id)).toEqual([f.student]);
  expect(
    (await call('get', '/attendance/events?student_id=' + f.foreignStudent, 'parent')).body.data,
  ).toEqual([]);
  for (const role of ['parent', 'student', 'teacher', 'principal']) {
    expect((await call('get', '/school/security', role)).status).toBe(403);
    expect((await call('get', '/exports', role)).status).toBe(403);
  }
  const policy = await call('get', '/school/security');
  expect(policy.status).toBe(200);
  expect(policy.body.student_login_enabled).toBe(true);
  expect(
    (
      await request(app)
        .put('/api/v1/school/security')
        .set('Authorization', 'Bearer ' + fixtureBearer('admin'))
        .set('X-School-Id', f.schoolA)
        .send({
          require_privileged_mfa: true,
          student_login_enabled: true,
          step_up_sensitive: false,
          device_offline_minutes: 3,
          policy_ref: 'Isolated policy approval',
        })
    ).status,
  ).toBe(403);
});
