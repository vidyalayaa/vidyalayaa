import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import request from 'supertest';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { portableDatabase, poolAdapters, fixture } from '../helpers/database.js';
import { transaction } from '../../apps/api/src/lib/db.js';
import { createApp } from '../../apps/api/src/app.js';
import type { Config } from '../../apps/api/src/lib/config.js';
import { sendLoginAlerts } from '../../apps/worker/src/login-alerts.js';
import { deliver, DeliveryError } from '../../apps/worker/src/providers.js';
vi.mock('../../apps/worker/src/providers.js', async (actual) => ({
  ...(await actual<typeof import('../../apps/worker/src/providers.js')>()),
  deliver: vi.fn(async () => 'test-email'),
}));
let db: PGlite,
  f: Awaited<ReturnType<typeof fixture>>,
  pools: ReturnType<typeof poolAdapters>,
  app: ReturnType<typeof createApp>;
let root: string;
const known = new Set<string>();
function token(uid: string, sid: string, exp = Math.floor(Date.now() / 1000) + 3600) {
  return (
    'test.' +
    Buffer.from(JSON.stringify({ sub: uid, session_id: sid, exp, aal: 'aal2' })).toString(
      'base64url',
    ) +
    '.verified'
  );
}
async function session(uid: string, options: { expired?: boolean; agent?: string } = {}) {
  const sid = crypto.randomUUID();
  await db.query(
    "INSERT INTO auth.sessions(id,user_id,user_agent,ip,not_after) VALUES($1,$2,$3,'2001:db8::1',$4)",
    [
      sid,
      uid,
      options.agent || 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0',
      options.expired ? '2020-01-01' : null,
    ],
  );
  await db.query(
    "INSERT INTO auth.refresh_tokens(session_id,token) VALUES($1,'private-test-refresh')",
    [sid],
  );
  return { sid, token: token(uid, sid) };
}
const call = (method: 'get' | 'post' | 'delete', path: string, bearer: string) =>
  request(app)
    [method]('/api/v1' + path)
    .set('Authorization', 'Bearer ' + bearer);
beforeAll(async () => {
  db = await portableDatabase();
  f = await fixture(db);
  pools = poolAdapters(db);
  root = crypto.randomUUID();
  await db.query(
    "INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,'super@example.invalid',now())",
    [root],
  );
  await db.query("INSERT INTO platform_staff(user_id,platform_role) VALUES($1,'SUPER_ADMIN')", [
    root,
  ]);
  for (const id of [root, f.admin, f.principal, f.teacher, f.parent, f.studentUser]) known.add(id);
  // Deliberately accepts retained JWTs after session deletion. The production
  // middleware must reject them by consulting the real provider session table.
  const supabase = {
    auth: {
      getUser: async (value: string) => {
        try {
          const c = JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString());
          if (known.has(c.sub)) return { data: { user: { id: c.sub } }, error: null };
        } catch {}
        return { data: { user: null }, error: { status: 401 } };
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
});
afterAll(async () => db.close());
it('lists only owned provider sessions for every role, including unobserved devices and current session', async () => {
  const foreign = await session(f.parent);
  for (const uid of [root, f.admin, f.principal, f.teacher, f.parent, f.studentUser]) {
    const current = await session(uid),
      other = await session(uid, {
        agent: 'Mozilla/5.0 (iPhone) Version/17.0 Mobile Safari/605.1',
      });
    const result = await call('get', '/account/sessions', current.token);
    expect(result.status).toBe(200);
    expect(result.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: current.sid,
          is_current: true,
          device: 'Windows computer',
          browser: 'Chrome',
          ip_address: '2001:db8::1',
          location: null,
        }),
        expect.objectContaining({
          id: other.sid,
          is_current: false,
          device: 'iPhone',
          browser: 'Safari',
        }),
      ]),
    );
    if (uid !== f.parent)
      expect(result.body.data.some((s: { id: string }) => s.id === foreign.sid)).toBe(false);
    expect(JSON.stringify(result.body)).not.toMatch(
      /private-test-refresh|refresh_token|user_agent|hmac|password/,
    );
    expect((await call('get', '/me', current.token)).body.sessionId).toBeUndefined();
  }
});
it('ends an individual remote provider session and its refresh tokens while retaining the current session', async () => {
  const current = await session(f.admin),
    other = await session(f.admin);
  expect((await call('delete', '/account/sessions/' + other.sid, current.token)).body).toEqual({
    ended: 1,
    current_session_ended: false,
  });
  expect(
    (
      await db.query('SELECT count(*)::int AS n FROM auth.refresh_tokens WHERE session_id=$1', [
        other.sid,
      ])
    ).rows[0],
  ).toEqual({ n: 0 });
  expect((await call('get', '/me', other.token)).status).toBe(401);
  expect((await call('get', '/me', current.token)).status).toBe(200);
  expect((await call('delete', '/account/sessions/' + other.sid, current.token)).status).toBe(404);
});
it('logs out every other session but preserves the current provider session, including on retry', async () => {
  const current = await session(f.teacher),
    one = await session(f.teacher),
    two = await session(f.teacher);
  const result = await call('post', '/account/sessions/logout-others', current.token);
  expect(result.status).toBe(200);
  expect(result.body.ended).toBeGreaterThanOrEqual(2);
  for (const s of [one, two])
    expect((await call('get', '/me', s.token)).body.error.code).toBe('SESSION_ENDED');
  expect((await call('get', '/me', current.token)).status).toBe(200);
  expect((await call('post', '/account/sessions/logout-others', current.token)).body.ended).toBe(0);
});
it('ends the current device without ending the user’s other sessions', async () => {
  const current = await session(f.studentUser),
    other = await session(f.studentUser);
  expect(
    (await call('delete', '/account/sessions/' + current.sid, current.token)).body
      .current_session_ended,
  ).toBe(true);
  expect((await call('get', '/me', current.token)).status).toBe(401);
  expect((await call('get', '/me', other.token)).status).toBe(200);
});
it('denies cross-user and cross-school control even to Super Admin and School Admin', async () => {
  const owner = await session(f.parent);
  const foreignAdmin = crypto.randomUUID();
  await db.query('INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,$2,now())', [
    foreignAdmin,
    foreignAdmin + '@example.invalid',
  ]);
  await db.query(
    "INSERT INTO school_memberships(school_id,user_id,role_id,status) SELECT $1,$2,id,'ACTIVE' FROM roles WHERE code='school_admin'",
    [f.schoolB, foreignAdmin],
  );
  known.add(foreignAdmin);
  for (const uid of [root, f.admin, f.principal, f.teacher, f.studentUser, foreignAdmin]) {
    const attacker = await session(uid);
    expect((await call('delete', '/account/sessions/' + owner.sid, attacker.token)).status).toBe(
      404,
    );
    // A valid identity with somebody else’s session id is rejected independently.
    expect((await call('get', '/account/sessions', token(uid, owner.sid))).status).toBe(401);
    const list = await call('get', '/account/sessions', attacker.token);
    expect(list.body.data.some((s: { id: string }) => s.id === owner.sid)).toBe(false);
  }
  expect((await call('get', '/me', owner.token)).status).toBe(200);
});
it('rejects expired provider sessions, expired JWTs and missing session claims', async () => {
  const expired = await session(f.parent, { expired: true }),
    current = await session(f.parent);
  expect((await call('get', '/me', expired.token)).status).toBe(401);
  const expiredToken = await call('get', '/me', token(f.parent, current.sid, 1));
  expect(expiredToken.status).toBe(401);
  expect(expiredToken.body.error.code).toBe('UNAUTHENTICATED');
  expect((await call('get', '/me', current.token)).status).toBe(200);
  expect(
    (
      await call(
        'get',
        '/me',
        'test.' +
          Buffer.from(JSON.stringify({ sub: f.parent })).toString('base64url') +
          '.verified',
      )
    ).status,
  ).toBe(401);
  const result = await call('get', '/account/sessions', current.token);
  expect(result.body.data.some((s: { id: string }) => s.id === expired.sid)).toBe(false);
  expect((await request(app).get('/api/v1/account/sessions')).status).toBe(401);
});
it('tracks activity with throttled writes and creates only one new-login alert per session', async () => {
  const current = await session(f.principal);
  await call('get', '/me', current.token);
  await call('get', '/me', current.token);
  expect(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM app.account_security_events WHERE session_id=$1 AND kind='NEW_LOGIN'",
        [current.sid],
      )
    ).rows[0],
  ).toEqual({ n: 1 });
  await db.query(
    "UPDATE app.login_session_activity SET last_active_at=now()-interval '2 minutes' WHERE session_id=$1",
    [current.sid],
  );
  await call('get', '/me', current.token);
  expect(
    (
      await db.query(
        "SELECT last_active_at>now()-interval '10 seconds' AS recent FROM app.login_session_activity WHERE session_id=$1",
        [current.sid],
      )
    ).rows[0],
  ).toEqual({ recent: true });
});
it('enforces own-session policies and denies direct provider/credential access to browser and runtime roles', async () => {
  for (const role of [
    'anon',
    'authenticated',
    'app_api',
    'app_platform',
    'app_worker',
    'app_device',
  ]) {
    const result = await db.query(
      "SELECT has_table_privilege($1,'auth.sessions','SELECT') AS sessions,has_table_privilege($1,'auth.refresh_tokens','SELECT') AS tokens,has_function_privilege($1,'app.end_account_sessions(uuid,uuid,boolean)','EXECUTE') AS revoke",
      [role],
    );
    expect(result.rows[0]).toEqual({ sessions: false, tokens: false, revoke: role === 'app_api' });
  }
  await transaction(pools.api, { userId: f.parent, schoolId: f.schoolA }, async (tx) => {
    expect(
      (await tx.query('SELECT user_id FROM app.account_security_events')).rows.every(
        (r) => r.user_id === f.parent,
      ),
    ).toBe(true);
  });
  const owner = await session(f.parent);
  await expect(
    transaction(pools.api, { userId: f.admin, schoolId: f.schoolA }, (tx) =>
      tx.query('SELECT app.end_account_sessions($1,$2,false)', [owner.sid, owner.sid]),
    ),
  ).rejects.toThrow('SESSION_EXPIRED');
});
it('deleting optional activity metadata cannot terminate or create provider sessions', async () => {
  const current = await session(f.parent);
  await call('get', '/me', current.token);
  await db.query('DELETE FROM app.login_session_activity WHERE session_id=$1', [current.sid]);
  expect((await call('get', '/me', current.token)).status).toBe(200);
  expect(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM app.account_security_events WHERE session_id=$1 AND kind='NEW_LOGIN'",
        [current.sid],
      )
    ).rows[0],
  ).toEqual({ n: 1 });
});
it('delivers login emails through the existing provider with stable keys, leases and retries', async () => {
  vi.stubEnv('RESEND_API_KEY', 'test-only');
  vi.stubEnv('EMAIL_FROM', 'test@example.invalid');
  try {
    await db.query(
      "UPDATE app.account_security_events SET email_status='NOT_REQUIRED' WHERE kind='NEW_LOGIN'",
    );
    await db.query('UPDATE auth.users SET email_confirmed_at=now() WHERE id=$1', [f.parent]);
    const current = await session(f.parent);
    await call('get', '/me', current.token);
    vi.mocked(deliver).mockRejectedValueOnce(new DeliveryError('TEMPORARY'));
    await sendLoginAlerts(pools.worker);
    const event = (
      await db.query<{ id: string; email_status: string }>(
        "SELECT id,email_status FROM app.account_security_events WHERE session_id=$1 AND kind='NEW_LOGIN'",
        [current.sid],
      )
    ).rows[0];
    expect(event.email_status).toBe('PENDING');
    await db.query('UPDATE app.account_security_events SET next_attempt_at=now() WHERE id=$1', [
      event.id,
    ]);
    await sendLoginAlerts(pools.worker);
    await sendLoginAlerts(pools.worker);
    expect(
      (
        await db.query('SELECT email_status FROM app.account_security_events WHERE id=$1', [
          event.id,
        ])
      ).rows[0],
    ).toEqual({ email_status: 'SENT' });
    expect(
      vi.mocked(deliver).mock.calls.filter((c) => c[3] === 'login-alert-' + event.id),
    ).toHaveLength(2);
    expect(vi.mocked(deliver).mock.calls.at(-1)?.[2]).not.toContain('private-test-refresh');
  } finally {
    vi.unstubAllEnvs();
  }
});
