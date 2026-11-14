import { afterAll, beforeAll, expect, it } from 'vitest';
import request from 'supertest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PGlite } from '@electric-sql/pglite';
import { createApp } from '../../apps/api/src/app.js';
import type { Config } from '../../apps/api/src/lib/config.js';
import { transaction } from '../../apps/api/src/lib/db.js';
import { fixture, poolAdapters, portableDatabase } from '../helpers/database.js';
import { scheduledJobs } from '../../apps/worker/src/jobs.js';

let db: PGlite;
let f: Awaited<ReturnType<typeof fixture>>;
let app: ReturnType<typeof createApp>;
let pools: ReturnType<typeof poolAdapters>;
let admin: Login;
let backup: string;
let finance: string;
let root: string;
const verified = new Set<string>();
type Login = { sid: string; bearer: (assurance?: 'aal1' | 'aal2', recent?: boolean) => string };

async function login(uid: string, ip = '192.0.2.10'): Promise<Login> {
  const sid = crypto.randomUUID();
  await db.query(
    "INSERT INTO auth.sessions(id,user_id,ip,user_agent) VALUES($1,$2,$3,'Windows Chrome/130')",
    [sid, uid, ip],
  );
  await db.query("INSERT INTO auth.refresh_tokens(session_id,token) VALUES($1,'test-only')", [sid]);
  return {
    sid,
    bearer: (aal = 'aal2', recent = true) =>
      'fixture.' +
      Buffer.from(
        JSON.stringify({
          sub: uid,
          session_id: sid,
          aal,
          exp: Math.floor(Date.now() / 1000) + 3600,
          amr: [{ method: 'totp', timestamp: Math.floor(Date.now() / 1000) - (recent ? 0 : 3600) }],
        }),
      ).toString('base64url') +
      '.verified',
  };
}
async function user(role: string, school = f.schoolA) {
  const id = crypto.randomUUID();
  await db.query('INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,$2,now())', [
    id,
    id + '@example.invalid',
  ]);
  await db.query(
    "INSERT INTO school_memberships(school_id,user_id,role_id,status) SELECT $1,$2,id,'ACTIVE' FROM roles WHERE code=$3",
    [school, id, role],
  );
  return id;
}
const call = (
  method: 'get' | 'put' | 'post' | 'patch',
  path: string,
  token = admin.bearer(),
  school = f.schoolA,
) =>
  request(app)
    [method]('/api/v1' + path)
    .set('Authorization', 'Bearer ' + token)
    .set('X-School-Id', school);
const draft = {
  require_privileged_mfa: false,
  step_up_sensitive: false,
  student_login_enabled: true,
  parent_login_enabled: true,
  mfa_teachers: false,
  mfa_finance_staff: false,
  new_login_alerts: true,
  suspicious_login_alerts: false,
  idle_timeout_minutes: null,
  device_offline_minutes: 3,
  policy_ref: 'SEC-101 approved',
  approval_details: 'Backup admin verified a recovery sign-in.',
};
async function change(
  input: Partial<
    Omit<typeof draft, 'idle_timeout_minutes'> & {
      idle_timeout_minutes: number | null;
      confirm_enforcement: boolean;
    }
  > = {},
  token = admin.bearer(),
) {
  const current = await call('get', '/school/security', token);
  expect(current.status).toBe(200);
  return call('put', '/school/security', token).send({
    ...draft,
    expected_version: current.body.version,
    ...input,
  });
}

beforeAll(async () => {
  db = await portableDatabase();
  f = await fixture(db);
  pools = poolAdapters(db);
  backup = await user('school_admin');
  finance = await user('finance_staff');
  root = await user('platform-only');
  await db.query("INSERT INTO platform_staff(user_id,platform_role) VALUES($1,'SUPER_ADMIN')", [
    root,
  ]);
  const supabase = {
    auth: {
      getUser: async (token: string) => {
        const { sub } = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
        return {
          data: { user: { id: sub, factors: verified.has(sub) ? [{ status: 'verified' }] : [] } },
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
    { ...pools, supabase },
  );
  admin = await login(f.admin);
});
afterAll(async () => {
  if (db) await db.close();
});

it('persists validated policy and immutable versions across new logins, rejects stale saves and enforces admin scope', async () => {
  expect((await call('get', '/school/security')).body).toMatchObject({
    version: 0,
    device_offline_minutes: 3,
    student_login_enabled: true,
    parent_login_enabled: true,
  });
  for (const uid of [f.principal, f.teacher, f.parent, f.studentUser, finance]) {
    const { bearer } = await login(uid);
    for (const path of ['/school/security', '/school/security/history', '/school/security/audit'])
      expect((await call('get', path, bearer())).status).toBe(403);
    expect((await call('put', '/school/security', bearer()).send(draft)).status).toBe(403);
  }
  expect((await call('get', '/school/security', admin.bearer(), f.schoolB)).status).toBe(404);
  expect((await change({ device_offline_minutes: 0 })).status).toBe(422);
  expect((await change({ idle_timeout_minutes: 241 })).status).toBe(422);
  expect((await change({ policy_ref: 'ab' })).status).toBe(422);
  expect((await change({ device_offline_minutes: 9 })).body).toMatchObject({
    version: 1,
    device_offline_minutes: 9,
    approved_by: f.admin,
    approved_by_name: 'school_admin Test',
  });
  expect(
    (await call('put', '/school/security').send({ ...draft, expected_version: 0 })).body.error.code,
  ).toBe('POLICY_VERSION_CHANGED');
  const again = await login(f.admin);
  expect((await call('get', '/school/security', again.bearer())).body).toMatchObject({
    version: 1,
    policy_ref: draft.policy_ref,
  });
  expect(
    (await db.query("SELECT settings->'security' AS policy FROM schools WHERE id=$1", [f.schoolA]))
      .rows[0],
  ).toMatchObject({
    policy: { version: 1, device_offline_minutes: 9 },
  });
  expect(
    (await call('get', '/school/security/history')).body.data.map(
      (p: { version: number }) => p.version,
    ),
  ).toEqual([1, 0]);
  const principalContext = { actorType: 'USER' as const, schoolId: f.schoolA, userId: f.principal };
  await expect(
    transaction(pools.api, principalContext, (tx) =>
      tx.query("UPDATE schools SET settings=jsonb_set(settings,'{security}', '{}') WHERE id=$1", [
        f.schoolA,
      ]),
    ),
  ).rejects.toThrow(/SECURITY_POLICY_ADMIN_REQUIRED/);
  expect(
    (
      await transaction(pools.api, principalContext, (tx) =>
        tx.query('SELECT * FROM app.school_security_policy_versions'),
      )
    ).rows,
  ).toEqual([]);
});

it('requires a fresh authenticator, a separate verified backup admin, and confirmation before stricter MFA', async () => {
  const options = {
    require_privileged_mfa: true,
    step_up_sensitive: true,
    mfa_teachers: true,
    mfa_finance_staff: true,
  };
  expect((await change(options, admin.bearer('aal2', false))).body.error.code).toBe(
    'MFA_ENROLLMENT_REQUIRED',
  );
  expect((await change(options)).body.error.code).toBe('POLICY_CONFIRMATION_REQUIRED');
  expect((await change({ ...options, confirm_enforcement: true })).body.error.code).toBe(
    'MFA_RECOVERY_REQUIRED',
  );
  for (const uid of [f.admin, backup]) {
    await db.query(
      "INSERT INTO auth.mfa_factors(user_id,factor_type,status) VALUES($1,'totp','verified')",
      [uid],
    );
    verified.add(uid);
  }
  expect((await call('get', '/school/security')).body.recovery_ready).toBe(false);
  const recoverySignIn = await login(backup);
  expect((await call('get', '/me', recoverySignIn.bearer('aal2', false))).status).toBe(200);
  expect((await call('get', '/school/security')).body.recovery_ready).toBe(false);
  expect((await call('get', '/me', recoverySignIn.bearer())).status).toBe(200);
  expect((await call('get', '/school/security')).body.recovery_ready).toBe(true);
  expect(
    (await change({ ...options, approval_details: '', confirm_enforcement: true })).body.error.code,
  ).toBe('MFA_RECOVERY_REQUIRED');
  expect((await change({ ...options, confirm_enforcement: true })).status).toBe(200);
  for (const path of ['/exports', '/Exports/'])
    expect((await call('post', path, admin.bearer('aal2', false)).send({})).body.error.code).toBe(
      'MFA_STEP_UP_REQUIRED',
    );
  for (const uid of [f.principal, f.teacher, finance]) {
    const { bearer } = await login(uid);
    expect((await call('get', '/me', bearer('aal1'))).body.security_mfa_required).toBe(true);
    expect((await call('get', '/school/security', bearer('aal1'))).body.error.code).toBe(
      'MFA_ENROLLMENT_REQUIRED',
    );
    expect((await call('get', '/me', bearer())).body.security_mfa_required).toBe(false);
  }
  expect((await call('get', '/me', admin.bearer('aal1'))).body.error.code).toBe('MFA_REQUIRED');
  expect((await change({}, admin.bearer('aal2', false))).body.error.code).toBe(
    'MFA_STEP_UP_REQUIRED',
  );
  expect((await change()).status).toBe(200);
  for (const uid of [f.principal, f.teacher, finance])
    expect(
      (await call('get', '/me', (await login(uid)).bearer('aal1'))).body.security_mfa_required,
    ).toBe(false);
  expect(
    (await call('get', '/me', (await login(root)).bearer('aal1'), '')).body.security_mfa_required,
  ).toBe(true);
  expect(
    (await call('get', '/platform/schools', (await login(root)).bearer('aal1'), '')).body.error
      .code,
  ).toBe('MFA_REQUIRED');
});

it('applies school-management authorization consistently to export and offboarding routes', async () => {
  const { bearer } = await login(f.teacher);
  for (const path of ['/exports', '/Exports/', '/offboarding', '/Offboarding/']) {
    expect((await call('get', path, bearer())).body.error.code).toBe('FORBIDDEN');
    expect((await call('get', path)).status).toBe(200);
  }
});

it('keeps regular report creation closed throughout an approved offboarding export window', async () => {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO school_offboarding(id,school_id,requested_by,policy_ref,reason,export_until,delete_after,status)
     VALUES($1,$2,$3,'TEST-OFFBOARDING','Isolated test',now()+interval '1 day',now()+interval '2 days','CLOSED')`,
    [id, f.schoolA, f.admin],
  );
  try {
    for (const path of ['/reports', '/Reports/'])
      expect((await call('post', path).send({})).body.error.code).toBe('SCHOOL_OFFBOARDED');
    expect((await call('get', '/exports')).status).toBe(200);
  } finally {
    await db.query('DELETE FROM school_offboarding WHERE id=$1', [id]);
  }
});

it('blocks already-issued student and parent sessions only for the school and restores access when reopened', async () => {
  const student = await login(f.studentUser);
  const parent = await login(f.parent);
  for (const account of [student, parent])
    expect((await call('get', '/me', account.bearer())).status).toBe(200);
  expect(
    (await change({ student_login_enabled: false, parent_login_enabled: false })).body.error.code,
  ).toBe('POLICY_CONFIRMATION_REQUIRED');
  expect(
    (
      await change({
        student_login_enabled: false,
        parent_login_enabled: false,
        confirm_enforcement: true,
      })
    ).status,
  ).toBe(200);
  for (const account of [student, parent]) {
    expect((await call('get', '/me', account.bearer())).body.error.code).toBe(
      'SCHOOL_LOGIN_DISABLED',
    );
    expect((await call('get', '/me', account.bearer(), '')).body.error.code).toBe(
      'SCHOOL_LOGIN_DISABLED',
    );
    expect((await call('get', '/profile/family', account.bearer())).status).toBe(403);
  }
  expect((await change()).status).toBe(200);
  for (const account of [student, parent])
    expect((await call('get', '/me', account.bearer())).status).toBe(200);
});

it('extends sessions on explicit activity only and revokes expired provider sessions and refresh credentials', async () => {
  const { bearer, sid } = await login(f.teacher);
  expect((await call('get', '/me', bearer())).body.idle_expires_at).toBeNull();
  expect((await change({ idle_timeout_minutes: 5, confirm_enforcement: true })).status).toBe(200);
  const age = async (minutes: number) =>
    db.query(
      'UPDATE app.login_session_activity SET last_interaction_at=now()-make_interval(mins=>$2) WHERE session_id=$1',
      [sid, minutes],
    );
  const baseline = await call('get', '/me', bearer());
  expect(baseline.body.idle_expires_at).toEqual(expect.any(String));
  await age(4);
  await db.query(
    "UPDATE schools SET settings=jsonb_set(settings,'{security,idle_timeout_changed_at}', to_jsonb(now()-interval '20 minutes')) WHERE id=$1",
    [f.schoolA],
  );
  const before = (await call('get', '/me', bearer())).body.idle_expires_at;
  expect((await call('get', '/me', bearer())).body.idle_expires_at).toBe(before);
  const activity = await call('post', '/account/sessions/activity', bearer());
  expect(activity.status).toBe(200);
  expect(Date.parse(activity.body.idle_expires_at)).toBeGreaterThan(Date.parse(before));
  await age(6);
  expect((await call('post', '/account/sessions/activity', bearer())).body.error.message).toMatch(
    /after inactivity/,
  );
  expect((await call('get', '/me', bearer())).status).toBe(401);
  expect((await db.query('SELECT 1 FROM auth.sessions WHERE id=$1', [sid])).rows).toHaveLength(0);
  expect(
    (await db.query('SELECT 1 FROM auth.refresh_tokens WHERE session_id=$1', [sid])).rows,
  ).toHaveLength(0);
  expect((await change()).status).toBe(200);
  expect(
    (await call('get', '/me', (await login(f.teacher)).bearer())).body.idle_expires_at,
  ).toBeNull();
});

it('uses the saved reader threshold and distinguishes new-login and unfamiliar-network email preferences', async () => {
  await db.query("UPDATE devices SET last_seen_at=now()-interval '5 minutes' WHERE id=$1", [
    f.deviceA,
  ]);
  const online = async () => {
    const result = await call('get', '/devices');
    expect(result.status).toBe(200);
    return result.body.data.find((row: { id: string }) => row.id === f.deviceA).online;
  };
  expect(await online()).toBe(false);
  expect(
    (
      await change({
        device_offline_minutes: 9,
        new_login_alerts: false,
        suspicious_login_alerts: true,
      })
    ).status,
  ).toBe(200);
  expect(await online()).toBe(true);
  const notices = () =>
    db.query(
      "SELECT 1 FROM platform_notices WHERE school_id=$1 AND kind='DEVICE_ALERT' AND split_part(source_ref,':',1)=$2",
      [f.schoolA, f.deviceA],
    );
  await scheduledJobs(pools.worker, f.schoolA);
  expect((await notices()).rows).toHaveLength(0);
  const regular = await login(f.parent);
  const unusual = await login(f.parent, '198.51.100.90');
  const alert = async (account: Login) => {
    expect((await call('get', '/me', account.bearer())).status).toBe(200);
    return (
      await db.query(
        "SELECT email_status,unfamiliar_network FROM app.account_security_events WHERE session_id=$1 AND kind='NEW_LOGIN'",
        [account.sid],
      )
    ).rows[0];
  };
  expect(await alert(regular)).toEqual({ email_status: 'NOT_REQUIRED', unfamiliar_network: false });
  expect(await alert(unusual)).toEqual({ email_status: 'PENDING', unfamiliar_network: true });
  expect((await change({ new_login_alerts: false, suspicious_login_alerts: false })).status).toBe(
    200,
  );
  await scheduledJobs(pools.worker, f.schoolA);
  expect((await notices()).rows).toHaveLength(1);
  expect(await alert(await login(f.parent, '203.0.113.20'))).toEqual({
    email_status: 'NOT_REQUIRED',
    unfamiliar_network: false,
  });
  expect((await change()).status).toBe(200);
  expect(await alert(await login(f.parent))).toEqual({
    email_status: 'PENDING',
    unfamiliar_network: false,
  });
});

it('revokes single-school sessions on membership deactivation and retains shared sessions while removing school access', async () => {
  const account = await login(f.parent);
  await call('get', '/me', account.bearer());
  const membership = (
    await db.query<{ id: string }>(
      'SELECT id FROM school_memberships WHERE user_id=$1 AND school_id=$2',
      [f.parent, f.schoolA],
    )
  ).rows[0].id;
  const update = (status: string) =>
    call('patch', '/memberships/' + membership).send({ role: 'parent', status });
  expect((await update('SUSPENDED')).status).toBe(200);
  expect((await call('get', '/me', account.bearer())).status).toBe(401);
  expect(
    (await db.query('SELECT 1 FROM auth.refresh_tokens WHERE session_id=$1', [account.sid])).rows,
  ).toHaveLength(0);
  expect((await update('ACTIVE')).status).toBe(200);
  const next = await login(f.parent);
  expect((await call('get', '/me', next.bearer())).status).toBe(200);
  await db.query(
    "INSERT INTO school_memberships(school_id,user_id,role_id,status) SELECT $1,$2,id,'ACTIVE' FROM roles WHERE code='parent'",
    [f.schoolB, f.parent],
  );
  expect((await update('SUSPENDED')).status).toBe(200);
  expect((await call('get', '/me', next.bearer())).status).toBe(404);
  expect((await call('get', '/me', next.bearer(), f.schoolB)).status).toBe(200);
});

it('shows sanitized provider and app audit events and excludes shared and foreign identities', async () => {
  const outsider = await user('teacher', f.schoolB);
  for (const [id, action] of [
    [f.teacher, 'user_updated_password'],
    [f.teacher, 'verification_attempted'],
    [f.teacher, 'mfa_code_login'],
    [f.teacher, 'factor_in_progress'],
    [f.parent, 'user_updated_password'],
    [outsider, 'user_updated_password'],
  ])
    await db.query(
      "INSERT INTO auth.audit_log_entries(payload,ip_address) VALUES($1,'192.0.2.44')",
      [{ actor_id: id, action, ignored_secret: 'must-never-appear' }],
    );
  await db.query("UPDATE users SET email='test-email-change@example.invalid' WHERE id=$1", [
    f.teacher,
  ]);
  const result = await call('get', '/school/security/audit?page_size=100');
  expect(result.status).toBe(200);
  expect(result.body.data).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ action: 'Security policy updated', actor: 'school_admin Test' }),
      expect.objectContaining({ action: 'School membership deactivated', account: 'parent Test' }),
      expect.objectContaining({
        action: 'Session created',
        ip_address: '192.0.2.10',
        device: 'Windows',
      }),
      expect.objectContaining({ action: 'Verified email changed', account: 'teacher Test' }),
      expect.objectContaining({
        action: 'Password changed',
        ip_address: '192.0.2.44',
        actor: 'teacher Test',
        outcome: 'SUCCESS',
      }),
      expect.objectContaining({ action: 'MFA verification attempted', outcome: 'ATTEMPTED' }),
      expect.objectContaining({ action: 'MFA sign-in', outcome: 'SUCCESS' }),
      expect.objectContaining({ action: 'MFA enrollment started' }),
    ]),
  );
  expect(
    result.body.data.filter((row: { action: string }) => row.action === 'Password changed'),
  ).toHaveLength(1);
  expect(JSON.stringify(result.body)).not.toMatch(
    /must-never-appear|test-email-change|refresh_token|user_agent/,
  );
});
