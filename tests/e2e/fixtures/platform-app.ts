import { withProviderSessions } from '../../helpers/provider-sessions';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PGlite } from '@electric-sql/pglite';
import { test as base } from './auth-app';
import { portableDatabase, poolAdapters, fixture } from '../../helpers/database';
import { createApp } from '../../../apps/api/src/app';
import type { Config } from '../../../apps/api/src/lib/config';

export function fixtureToken(id: string, aal = 'aal2', sid = id, verifiedAt?: number) {
  return [
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(
      JSON.stringify({
        sub: id,
        aal,
        session_id: sid,
        exp: Math.floor(Date.now() / 1000) + 3600,
        amr: verifiedAt === undefined ? undefined : [{ method: 'totp', timestamp: verifiedAt }],
      }),
    ).toString('base64url'),
    Buffer.from('fixture-signature').toString('base64url'),
  ].join('.');
}
export interface PlatformApp {
  pools: ReturnType<typeof poolAdapters>;
  storage: SupabaseClient;
  objects: Map<string, Buffer>;
  db: PGlite;
  records: Awaited<ReturnType<typeof fixture>>;
  root: string;
  purgeJob: string;
  supportTicket: string;
  request: (
    path: string,
    method?: string,
    body?: unknown,
    user?: string,
    school?: string,
    aal?: string,
  ) => Promise<{ status: number; body: any }>;
  url: string;
  registerIdentity: (id: string) => void;
  enrollAuthenticator: (id: string) => Promise<string>;
}

// Only Auth and outbound email are simulated. The browser's REST traffic goes
// through the actual Express app, runtime database roles, migrations and RLS.
export const test = base.extend<{}, { platformApp: PlatformApp }>({
  platformApp: [
    async ({}, use) => {
      if (process.env.NATIVE_FIXTURE_DATABASE_URL)
        throw new Error('Browser checks require the disposable in-memory database.');
      const db = await portableDatabase();
      let server: Server | undefined;
      try {
        const records = await fixture(db),
          root = randomUUID();
        await db.query(
          "INSERT INTO auth.users(id,email,email_confirmed_at,raw_user_meta_data) VALUES($1,'platform@example.test',now(),$2)",
          [root, { full_name: 'Platform operator' }],
        );
        await db.query(
          "INSERT INTO platform_staff(user_id,platform_role) VALUES($1,'SUPER_ADMIN')",
          [root],
        );
        const firstAdmin = randomUUID(),
          purgeJob = randomUUID(),
          supportTicket = randomUUID();
        await db.query("INSERT INTO auth.users(id,email) VALUES($1,'setup-admin@example.test')", [
          firstAdmin,
        ]);
        await db.query(
          "INSERT INTO support_requests(id,school_id,requested_by,subject,category,description) VALUES($1,$2,$3,'Platform support fixture','ACCOUNT','Please review the administrator account setup.')",
          [supportTicket, records.schoolA, records.admin],
        );
        await db.query(
          "INSERT INTO platform_notices(school_id,kind,source_ref) VALUES($1,'DEVICE_ALERT','isolated-notice')",
          [records.schoolA],
        );
        await db.query(
          "INSERT INTO school_usage_snapshots(school_id,on_date,active_students,devices,notifications_sent) VALUES($1,'2026-10-21',321,2,15)",
          [records.schoolA],
        );
        await db.query(
          "INSERT INTO school_offboarding(id,school_id,requested_by,policy_ref,reason,export_until,delete_after,status,legal_hold,school_approved_by,closed_by,closed_at) VALUES($1,$2,$3,'TEST-PURGE-POLICY','Approved generated fixture closure',now()-interval '2 days',now()-interval '1 day','CLOSED',false,$4,$3,now()-interval '3 days')",
          [purgeJob, records.schoolB, root, records.admin],
        );
        await db.query(
          "INSERT INTO organizations(name) SELECT 'Generated campus '||n FROM generate_series(1,105) n",
        );
        const closureSchool = randomUUID();
        await db.query(
          "INSERT INTO schools(id,school_code,name,timezone,status) VALUES($1,'CLOSE_UI','Closure Website School','UTC','ACTIVE')",
          [closureSchool],
        );
        await db.query(
          "INSERT INTO subscriptions(school_id,plan_id,status,current_period_end) SELECT $1,id,'ACTIVE',now()+interval '1 year' FROM subscription_plans WHERE code='BASIC'",
          [closureSchool],
        );
        await db.query(
          "INSERT INTO school_memberships(school_id,user_id,role_id,status) SELECT $1,$2,id,'ACTIVE' FROM roles WHERE code='school_admin'",
          [closureSchool, records.admin],
        );
        const outbox = randomUUID();
        await db.query(
          "INSERT INTO notification_outbox(id,school_id,student_id,kind,dedupe_key,payload,status) VALUES($1,$2,$3,'FEE_REMINDER','fixture-failed-notification',$4,'COMPLETED')",
          [outbox, records.schoolA, records.student, { fee_type: 'Generated failed delivery' }],
        );
        await db.query(
          "INSERT INTO notification_deliveries(school_id,outbox_id,parent_id,channel,status,last_error) VALUES($1,$2,$3,'EMAIL','FAILED','Fixture provider timeout')",
          [records.schoolA, outbox, records.parentId],
        );
        await db.query(
          "INSERT INTO attendance_events(school_id,device_id,device_event_id,sequence_number,boot_id,card_uid,student_id,location_type,event_ts,effective_ts,time_source,timestamp_trust,firmware_version,status,outcome) VALUES($1,$2,$3,1,$4,'AABBCCDD',$5,'ENTRY','2026-10-21T02:40Z','2026-10-21T02:40Z','RTC_UNSYNCED','SUSPECT','fixture','RECORDED','QUARANTINED_TIMESTAMP')",
          [records.schoolA, records.deviceA, randomUUID(), randomUUID(), records.student],
        );
        const known = new Set([
          root,
          firstAdmin,
          records.admin,
          records.principal,
          records.teacher,
          records.parent,
          records.studentUser,
        ]);
        const objects = new Map<string, Buffer>();
        const enrolled = new Map<string, string>();
        const auth = {
          storage: {
            from: () => ({
              createSignedUploadUrl: async (path: string) => ({
                data: { path, token: 'fixture-upload-token' },
                error: null,
              }),
              upload: async (path: string, body: Buffer | Blob) => {
                objects.set(
                  path,
                  body instanceof Blob ? Buffer.from(await body.arrayBuffer()) : Buffer.from(body),
                );
                return { error: null };
              },
              download: async (path: string) =>
                objects.has(path)
                  ? { data: new Blob([objects.get(path)!]), error: null }
                  : { data: null, error: { message: 'Fixture object missing' } },
              remove: async (paths: string[]) => {
                paths.forEach((path) => objects.delete(path));
                return { error: null };
              },
            }),
          },
          auth: {
            getUser: async (token: string) => {
              let id: string;
              try {
                id = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub;
              } catch {
                return { data: { user: null }, error: { status: 401 } };
              }
              const user = known.has(id) ? { id } : null;
              return {
                data: {
                  user: user
                    ? {
                        ...user,
                        factors: enrolled.has(id)
                          ? [{ id: enrolled.get(id), status: 'verified', factor_type: 'totp' }]
                          : [],
                      }
                    : null,
                },
                error: user ? null : { status: 401 },
              };
            },
            admin: {
              inviteUserByEmail: async (email: string, options: { data: unknown }) => {
                return email === 'setup-admin@example.test'
                  ? { data: { user: { id: firstAdmin, email } }, error: null }
                  : {
                      data: { user: null },
                      error: { message: 'No outbound email in this fixture.' },
                    };
              },
            },
          },
        } as unknown as SupabaseClient;
        const pools = poolAdapters(db);
        const app = createApp(
          {
            NODE_ENV: 'test',
            WEB_ORIGINS: 'http://127.0.0.1:5187,http://127.0.0.1:5188',
            TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32),
            TRUST_PROXY_HOPS: 0,
          } as Config,
          { ...pools, supabase: withProviderSessions(db, auth) },
        );
        server = app.listen(0, '127.0.0.1');
        await new Promise<void>((resolve, reject) => {
          server!.once('listening', resolve);
          server!.once('error', reject);
        });
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Isolated API did not start.');
        const url = `http://127.0.0.1:${address.port}`;
        await use({
          pools,
          storage: auth,
          objects,
          db,
          records,
          root,
          purgeJob,
          supportTicket,
          url,
          registerIdentity: (id) => {
            known.add(id);
          },
          enrollAuthenticator: async (id) => {
            const factor = randomUUID();
            await db.query('UPDATE auth.users SET email_confirmed_at=now() WHERE id=$1', [id]);
            await db.query(
              "INSERT INTO auth.mfa_factors(id,user_id,factor_type,status) VALUES($1,$2,'totp','verified')",
              [factor, id],
            );
            enrolled.set(id, factor);
            return factor;
          },
          request: async (path, method = 'GET', body, user = root, school, aal = 'aal2') => {
            const response = await fetch(url + '/api/v1' + path, {
              method,
              headers: {
                Authorization: `Bearer ${fixtureToken(user, aal)}`,
                ...(school ? { 'X-School-Id': school } : {}),
                ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
              },
              body: body === undefined ? undefined : JSON.stringify(body),
            });
            return {
              status: response.status,
              body: response.status === 204 ? undefined : await response.json(),
            };
          },
        });
      } finally {
        if (server) {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server!.close(() => resolve()));
        }
        await db.close();
      }
    },
    { scope: 'worker', timeout: 120000 },
  ],
  isolateServices: [
    async ({ page, platformApp }, use) => {
      const user = {
        id: platformApp.root,
        email: 'platform@example.test',
        aud: 'authenticated',
        role: 'authenticated',
        factors: [],
        app_metadata: {},
        user_metadata: {},
        created_at: '2026-01-01T00:00:00Z',
      };
      await page.addInitScript(
        (value) => localStorage.setItem('sb-mfa-qr-auth-token', JSON.stringify(value)),
        {
          user,
          access_token: fixtureToken(user.id),
          refresh_token: 'isolated-refresh',
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        },
      );
      await page.route('https://mfa-qr.test/auth/v1/logout**', (route) =>
        route.fulfill({ status: 204 }),
      );
      await page.route('https://mfa-qr.test/auth/v1/user', (route) =>
        route.fulfill({ json: user }),
      );
      await page.route('**/api/v1/**', async (route) => {
        const target = new URL(route.request().url());
        const response = await route.fetch({
          url: platformApp.url + target.pathname + target.search,
        });
        await route.fulfill({ response });
      });
      await use();
    },
    { auto: true },
  ],
});
