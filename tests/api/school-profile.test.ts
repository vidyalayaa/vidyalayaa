import { beforeAll, afterAll, it, expect } from 'vitest';
import request from 'supertest';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  schoolProfileDetailsSchema,
  schoolProfileAdminSchema,
  defaultSchoolTimings,
} from '@vidyalayaa/contracts';
import { portableDatabase, fixture, poolAdapters } from '../helpers/database.js';
import { fixtureBearer, withProviderSessions } from '../helpers/provider-sessions.js';
import { createApp } from '../../apps/api/src/app.js';
import type { Config } from '../../apps/api/src/lib/config.js';
import { transaction } from '../../apps/api/src/lib/db.js';
let db: PGlite,
  f: Awaited<ReturnType<typeof fixture>>,
  pools: ReturnType<typeof poolAdapters>,
  app: ReturnType<typeof createApp>;
const root = crypto.randomUUID(),
  runtime = {
    api: 'profile_api_' + root.replaceAll('-', ''),
    platform: 'profile_platform_' + root.replaceAll('-', ''),
  },
  objects = new Map<string, Buffer>(),
  png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  );
let failUpload = false;
beforeAll(async () => {
  db = await portableDatabase();
  f = await fixture(db);
  await db.exec(`
    CREATE ROLE ${runtime.api} LOGIN INHERIT;
    CREATE ROLE ${runtime.platform} LOGIN INHERIT;
    GRANT app_api TO ${runtime.api};
    GRANT app_platform TO ${runtime.platform};
  `);
  pools = poolAdapters(db, runtime);
  await db.query("INSERT INTO auth.users(id,email) VALUES($1,'profile-root@example.invalid')", [
    root,
  ]);
  await db.query("INSERT INTO platform_staff(user_id,platform_role) VALUES($1,'SUPER_ADMIN')", [
    root,
  ]);
  const identities: Record<string, string> = {
    root,
    admin: f.admin,
    principal: f.principal,
    teacher: f.teacher,
    parent: f.parent,
    student: f.studentUser,
  };
  const storage = {
    auth: {
      getUser: async (token: string) => {
        let id = identities[token];
        if (!id) {
          try {
            if (JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub === root)
              id = root;
          } catch {}
        }
        return { data: { user: id ? { id, factors: [] } : null }, error: null };
      },
    },
    storage: {
      from: () => ({
        upload: async (path: string, bytes: Buffer) => {
          if (failUpload) return { error: { message: 'unavailable' } };
          objects.set(path, Buffer.from(bytes));
          return { error: null };
        },
        download: async (path: string) =>
          objects.has(path)
            ? { data: new Blob([objects.get(path)!]), error: null }
            : { data: null, error: { message: 'missing' } },
        remove: async (paths: string[]) => {
          paths.forEach((p) => objects.delete(p));
          return { error: null };
        },
      }),
    },
  } as unknown as SupabaseClient;
  app = createApp(
    {
      NODE_ENV: 'test',
      WEB_ORIGINS: 'http://localhost:5173',
      TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32),
      TRUST_PROXY_HOPS: 0,
    } as Config,
    { ...pools, supabase: withProviderSessions(db, storage) },
  );
});
afterAll(async () => {
  if (!db) return;
  try {
    await db.exec(`DROP ROLE IF EXISTS ${runtime.api}, ${runtime.platform}`);
  } finally {
    await db.close();
  }
});
function call(method: 'get' | 'put' | 'post' | 'delete', path = '/school-profile', role = 'admin') {
  const token =
    role === 'root'
      ? 'fixture.' +
        Buffer.from(JSON.stringify({ sub: root, aal: 'aal2' })).toString('base64url') +
        '.fixture'
      : role;
  const req = request(app)
    [method]('/api/v1' + path)
    .set('Authorization', 'Bearer ' + fixtureBearer(token));
  return role === 'root' ? req : req.set('X-School-Id', f.schoolA);
}
async function body(role = 'admin', path = '/school-profile') {
  const result = await call('get', path, role);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  const p = result.body;
  return {
    expected_version: p.version,
    name: p.name,
    timezone: p.timezone,
    locale: p.locale,
    details: p.details,
    ...(p.administration ? { administration: p.administration } : {}),
  };
}
it('provides one existing-school profile to all member roles without creating records on read', async () => {
  for (const role of ['admin', 'principal', 'teacher', 'parent', 'student']) {
    const result = await call('get', '/school-profile', role);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body).toMatchObject({
      school_id: f.schoolA,
      name: 'Test School A',
      version: 0,
      can_edit: role === 'admin',
    });
    expect(result.body.administration !== undefined).toBe(['admin', 'principal'].includes(role));
  }
  expect((await db.query('SELECT school_id FROM school_profile_private')).rows).toEqual([]);
  expect((await request(app).get('/api/v1/school-profile')).status).toBe(401);
});
it('saves incomplete profiles and private contacts while preserving school settings and records', async () => {
  await db.query(
    'UPDATE schools SET settings=settings||\'{"existing_setting":"preserve"}\'::jsonb WHERE id=$1',
    [f.schoolA],
  );
  const b = await body();
  const saved = await call('put').send({
    ...b,
    details: schoolProfileDetailsSchema.parse({
      email: 'office@example.invalid',
      phone: '+91 9999999999',
      city: 'Lucknow',
      board: 'CBSE',
      principal_name: 'Principal Example',
    }),
    administration: schoolProfileAdminSchema.parse({
      management_name: 'Management Trust',
      management_phone: '+91 8888888888',
      internal_policies: 'Confidential administrative note',
    }),
  });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  expect(saved.body.version).toBe(1);
  expect(saved.body.completion.percent).toBeGreaterThan(0);
  expect(saved.body.completion.percent).toBeLessThan(100);
  expect(saved.body.completion.missing.some((m: any) => m.key === 'address_line1')).toBe(true);
  expect(
    (
      await db.query("SELECT settings->>'existing_setting' AS value FROM schools WHERE id=$1", [
        f.schoolA,
      ])
    ).rows[0].value,
  ).toBe('preserve');
  expect(
    (await db.query('SELECT id FROM students WHERE school_id=$1', [f.schoolA])).rows,
  ).toHaveLength(1);
});
it('rejects stale edits and invalid or injected profile fields without partial writes', async () => {
  const b = await body();
  expect((await call('put').send({ ...b, expected_version: 0 })).status).toBe(409);
  for (const details of [
    { ...b.details, website: 'javascript:alert(1)' },
    { ...b.details, email: 'invalid' },
    { ...b.details, recognition_valid_until: '2026-02-30' },
    { ...b.details, secret_key: 'forged' },
  ])
    expect((await call('put').send({ ...b, details })).status).toBe(422);
  expect((await call('put').send({ ...b, school_id: f.schoolB })).status).toBe(422);
  expect((await call('get')).body.version).toBe(b.expected_version);
});
it('keeps families and school staff out of administrative details in API and database policies', async () => {
  const b = await body();
  for (const [role, userId] of [
    ['parent', f.parent],
    ['student', f.studentUser],
    ['teacher', f.teacher],
  ] as const) {
    const read = await call('get', '/school-profile', role);
    expect(JSON.stringify(read.body)).not.toContain('Confidential administrative note');
    expect(read.body).not.toHaveProperty('administration');
    expect(read.body.completion).toBeNull();
    expect((await call('put', '/school-profile', role).send(b)).status).toBe(403);
    await transaction(pools.api, { schoolId: f.schoolA, userId }, async (tx) => {
      expect((await tx.query('SELECT * FROM school_profile_private')).rows).toEqual([]);
      expect(
        (
          await tx.query(
            'UPDATE school_profile_private SET principal_edit_authorized=true RETURNING school_id',
          )
        ).rows,
      ).toEqual([]);
    });
    await expect(
      transaction(pools.api, { schoolId: f.schoolA, userId }, (tx) =>
        tx.query('UPDATE schools SET profile=profile||\'{"city":"Forged"}\'::jsonb WHERE id=$1', [
          f.schoolA,
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  }
});
it('gives Principal read-only access by default and supports explicit, revocable profile-only delegation', async () => {
  let b = await body('principal');
  expect((await call('put', '/school-profile', 'principal').send(b)).status).toBe(403);
  const admin = await body();
  expect((await call('put').send({ ...admin, principal_edit_authorized: true })).status).toBe(200);
  await expect(
    transaction(pools.api, { schoolId: f.schoolA, userId: f.principal }, (tx) =>
      tx.query(
        'UPDATE school_profile_private SET principal_edit_authorized=false WHERE school_id=$1',
        [f.schoolA],
      ),
    ),
  ).rejects.toMatchObject({ code: '42501' });
  b = await body('principal');
  expect(
    (
      await call('put', '/school-profile', 'principal').send({
        ...b,
        details: { ...b.details, motto: 'Principal approved update' },
      })
    ).status,
  ).toBe(200);
  b = await body('principal');
  expect(
    (
      await call('put', '/school-profile', 'principal').send({
        ...b,
        principal_edit_authorized: false,
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await call('put', '/school-profile/timings', 'principal').send({
        expected_version: 0,
        settings: defaultSchoolTimings,
      })
    ).status,
  ).toBe(403);
  expect(
    (await call('put').send({ ...(await body()), principal_edit_authorized: false })).status,
  ).toBe(200);
  expect(
    (await call('put', '/school-profile', 'principal').send(await body('principal'))).status,
  ).toBe(403);
});
it('isolates every school and allows Super Admin to edit all profiles without support access to children', async () => {
  const allowed = (userId: string) =>
    transaction(pools.platform, { schoolId: '', userId }, (tx) =>
      tx.query('SELECT app.school_profile_editor($1) AS allowed', [f.schoolB]),
    );
  expect((await allowed(root)).rows).toEqual([{ allowed: true }]);
  expect((await allowed(f.admin)).rows).toEqual([{ allowed: false }]);
  expect((await call('get').set('X-School-Id', f.schoolB)).status).toBe(404);
  const path = `/platform/schools/${f.schoolB}/profile`;
  expect((await call('get', path, 'admin')).status).toBe(403);
  const b = await body('root', path);
  const save = await call('put', path, 'root').send({
    ...b,
    details: { ...b.details, city: 'Other school city' },
    administration: schoolProfileAdminSchema.parse({ management_name: 'School B trust' }),
  });
  expect(save.status, JSON.stringify(save.body)).toBe(200);
  expect((await call('get')).body.details.city).toBe('Lucknow');
  await transaction(pools.api, { schoolId: f.schoolA, userId: f.admin }, async (tx) => {
    expect(
      (await tx.query('SELECT * FROM school_profile_private WHERE school_id=$1', [f.schoolB])).rows,
    ).toEqual([]);
  });
  const rights = (
    await db.query(
      "SELECT has_table_privilege($1,'students','SELECT') AS pupils,has_function_privilege($1,'app.school_role(uuid)','EXECUTE') AS school_role,has_table_privilege('authenticated','school_profile_private','SELECT') AS browser,has_table_privilege('anon','school_profile_assets','SELECT') AS anon",
      [runtime.platform],
    )
  ).rows[0];
  expect(rights).toEqual({ pupils: false, school_role: false, browser: false, anon: false });
});
it('enforces timing guards for inherited school database logins', async () => {
  await expect(
    transaction(pools.api, { schoolId: f.schoolA, userId: f.principal }, (tx) =>
      tx.query("UPDATE schools SET settings=jsonb_set(settings,'{timetable}',$2) WHERE id=$1", [
        f.schoolA,
        { ...defaultSchoolTimings, version: 1 },
      ]),
    ),
  ).rejects.toMatchObject({ code: '42501' });
});
it('reuses timetable settings and validates version, timing permissions and overlaps', async () => {
  const saved = await call('put', '/school-profile/timings').send({
    expected_version: 0,
    settings: defaultSchoolTimings,
  });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  expect((await call('get', '/timetable/settings')).body.settings).toEqual(defaultSchoolTimings);
  expect((await call('get', '/school-profile', 'student')).body.timings.settings).toEqual(
    defaultSchoolTimings,
  );
  expect(
    (
      await call('put', '/school-profile/timings').send({
        expected_version: 0,
        settings: defaultSchoolTimings,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await call('put', '/school-profile/timings').send({
        expected_version: 1,
        settings: {
          ...defaultSchoolTimings,
          periods: defaultSchoolTimings.periods.map((p) => ({
            ...p,
            start_time: '09:00',
            end_time: '10:00',
          })),
        },
      })
    ).status,
  ).toBe(422);
  const path = `/platform/schools/${f.schoolB}/profile/timings`;
  const global = await call('put', path, 'root').send({
    expected_version: 0,
    settings: defaultSchoolTimings,
  });
  expect(global.status, JSON.stringify(global.body)).toBe(200);
});
let logo: string;
it('uploads real validated bytes to the private school bucket and authorizes every download', async () => {
  const saved = await call('post', '/school-profile/assets')
    .field('kind', 'LOGO')
    .field('title', 'Official school logo')
    .attach('file', png, { filename: '../forged-name.png', contentType: 'image/png' });
  expect(saved.status, JSON.stringify(saved.body)).toBe(201);
  logo = saved.body.id;
  expect([...objects.keys()][0]).toBe(`${f.schoolA}/profile/${logo}.png`);
  const file = await call('get', `/school-profile/assets/${logo}`, 'parent');
  expect(file.status).toBe(200);
  expect(file.headers['content-type']).toContain('image/png');
  expect(file.body).toEqual(png);
  expect(
    (await call('get', `/platform/schools/${f.schoolB}/profile/assets/${logo}`, 'root')).status,
  ).toBe(404);
  expect(
    (
      await call('post', '/school-profile/assets', 'teacher')
        .field('kind', 'IMAGE')
        .field('title', 'Forbidden')
        .attach('file', png, 'image.png')
    ).status,
  ).toBe(403);
});
it('rejects spoofed, oversized and unsafe media and rolls back metadata on storage failure', async () => {
  for (const [bytes, type] of [
    [Buffer.from('<svg onload="alert(1)"/>'), 'image/svg+xml'],
    [Buffer.from('%PDF-1.7\nspoof'), 'image/png'],
    [Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024)]), 'image/png'],
  ] as const)
    expect(
      (
        await call('post', '/school-profile/assets')
          .field('kind', 'IMAGE')
          .field('title', 'Invalid')
          .attach('file', bytes, { filename: 'test.png', contentType: type })
      ).status,
    ).toBe(422);
  failUpload = true;
  try {
    expect(
      (
        await call('post', '/school-profile/assets')
          .field('kind', 'IMAGE')
          .field('title', 'Storage failure')
          .attach('file', png, { filename: 'image.png', contentType: 'image/png' })
      ).status,
    ).toBe(503);
  } finally {
    failUpload = false;
  }
  expect((await call('get')).body.assets).toHaveLength(1);
});
it('replaces a logo and removes policy documents without deleting historical file records', async () => {
  const next = await call('post', '/school-profile/assets')
    .field('kind', 'LOGO')
    .field('title', 'New logo')
    .attach('file', png, { filename: 'logo.png', contentType: 'image/png' });
  expect(next.status, JSON.stringify(next.body)).toBe(201);
  expect((await call('get', `/school-profile/assets/${logo}`, 'student')).status).toBe(404);
  const policy = await call('post', '/school-profile/assets')
    .field('kind', 'POLICY')
    .field('title', 'School safety policy')
    .attach('file', Buffer.from('%PDF-1.7\nPolicy test\n%%EOF'), {
      filename: 'policy.pdf',
      contentType: 'application/pdf',
    });
  expect(policy.status, JSON.stringify(policy.body)).toBe(201);
  expect(
    (await call('get', `/school-profile/assets/${policy.body.id}`, 'student')).headers[
      'content-disposition'
    ],
  ).toContain('attachment');
  expect((await call('delete', `/school-profile/assets/${policy.body.id}`)).status).toBe(204);
  expect((await call('get', `/school-profile/assets/${policy.body.id}`, 'student')).status).toBe(
    404,
  );
  expect(
    (
      await db.query(
        'SELECT id FROM school_profile_assets WHERE retired_at IS NOT NULL AND school_id=$1',
        [f.schoolA],
      )
    ).rows,
  ).toHaveLength(2);
});
it('uses published and audience-scoped announcements from the existing system', async () => {
  for (const [title, audience, published] of [
    ['School public announcement', 'SCHOOL', '2026-01-01'],
    ['Staff private notice', 'STAFF', '2026-01-01'],
    ['Unpublished announcement', 'SCHOOL', null],
  ] as const)
    await db.query(
      'INSERT INTO announcements(school_id,title,body,audience,published_at,created_by) VALUES($1,$2,$2,$3,$4,$5)',
      [f.schoolA, title, audience, published, f.admin],
    );
  for (const role of ['parent', 'student']) {
    const result = await call('get', '/school-profile', role);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.announcements.map((n: any) => n.title)).toEqual([
      'School public announcement',
    ]);
  }
});
it('preserves existing registration and accepts basic contact information for new schools', async () => {
  const saved = await call('post', '/platform/schools', 'root').send({
    school_code: 'PROFILE_TEST',
    name: 'Profile registration school',
    timezone: 'Asia/Kolkata',
    plan_code: 'PROFESSIONAL',
    trial_ends_at: new Date(Date.now() + 86400000 * 30).toISOString(),
    email: 'new-school@example.invalid',
    phone: '+91 7777777777',
    address_line1: 'Example Road',
    city: 'Example City',
    country: 'India',
  });
  expect(saved.status, JSON.stringify(saved.body)).toBe(201);
  const p = (await call('get', `/platform/schools/${saved.body.id}/profile`, 'root')).body;
  expect(p.details).toMatchObject({
    email: 'new-school@example.invalid',
    city: 'Example City',
    address_line1: 'Example Road',
  });
  expect(p.completion.percent).toBeLessThan(100);
});
it('reaches full completion from real saved fields, logo and the shared school timing configuration', async () => {
  const b = await body();
  const saved = await call('put').send({
    ...b,
    details: {
      ...b.details,
      about: 'School information',
      address_line1: 'Example Street',
      state: 'Uttar Pradesh',
      postal_code: '226001',
      country: 'India',
      affiliation_number: 'EXAMPLE-001',
      grades_offered: '1–12',
      medium: 'English',
      facilities: ['Library'],
      emergency_phone: '+91 9999999999',
      policies: 'Contact the school office for attendance and safety policies.',
    },
  });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  expect(saved.body.completion).toMatchObject({ percent: 100, missing: [] });
});
it('preserves suspended-school restrictions without changing saved profile records', async () => {
  const b = await body();
  await db.query("UPDATE subscriptions SET status='SUSPENDED' WHERE school_id=$1", [f.schoolA]);
  try {
    expect((await call('get')).status).toBe(403);
    expect((await call('put').send(b)).status).toBe(403);
    expect(
      (
        await call('post', '/school-profile/assets')
          .field('kind', 'IMAGE')
          .field('title', 'Forbidden')
          .attach('file', png, { filename: 'logo.png', contentType: 'image/png' })
      ).status,
    ).toBe(403);
    expect(
      (await db.query('SELECT profile_version FROM schools WHERE id=$1', [f.schoolA])).rows[0]
        .profile_version,
    ).toBe(b.expected_version);
  } finally {
    await db.query("UPDATE subscriptions SET status='ACTIVE' WHERE school_id=$1", [f.schoolA]);
  }
});
