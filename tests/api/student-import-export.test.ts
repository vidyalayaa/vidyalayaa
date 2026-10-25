import { beforeAll, afterAll, expect, it } from 'vitest';
import request from 'supertest';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { portableDatabase, poolAdapters, fixture } from '../helpers/database.js';
import { fixtureBearer, withProviderSessions } from '../helpers/provider-sessions.js';
import { createApp } from '../../apps/api/src/app.js';
import type { Config } from '../../apps/api/src/lib/config.js';
import { parseCsv } from '../../apps/web/src/lib/csv.js';

let db: PGlite, f: Awaited<ReturnType<typeof fixture>>, app: ReturnType<typeof createApp>;
const call = (method: 'get' | 'post', path: string, role = 'admin', school?: string) =>
  request(app)
    [method]('/api/v1' + path)
    .set('Authorization', 'Bearer ' + fixtureBearer(role))
    .set('X-School-Id', school || f.schoolA);
const row = (code: string) => ({
  student_code: code,
  first_name: 'Imported ' + code,
  last_name: 'Learner',
  email: code.toLowerCase() + '@example.test',
  date_of_birth: '2013-02-03',
  gender: 'FEMALE',
  status: 'ACTIVE',
  academic_session: 'Test year',
  class_grade: '8',
  class_section: 'A',
  roll_number: code,
  starts_on: '2026-01-01',
  ends_on: '2027-12-31',
  parent_1_mode: 'NEW',
  parent_1_full_name: 'Parent ' + code,
  parent_1_email: code.toLowerCase() + '-parent@example.test',
  parent_1_phone: '+919876543210',
  parent_1_relationship: 'MOTHER',
  parent_1_is_primary_contact: true,
  parent_1_can_receive_alerts: false,
});
const commit = (rows: unknown[], key = crypto.randomUUID()) =>
  call('post', '/student-directory/imports')
    .set('Idempotency-Key', key)
    .send({ rows, validate_only: false });
async function counts() {
  return (
    await db.query(`SELECT (SELECT count(*) FROM students) AS students,(SELECT count(*) FROM parents) AS parents,
    (SELECT count(*) FROM enrollments) AS enrollments,(SELECT count(*) FROM student_parents) AS links,(SELECT count(*) FROM audit_logs) AS audits,
    (SELECT count(*) FROM users) AS users,(SELECT count(*) FROM school_invitations) AS invitations`)
  ).rows[0];
}
beforeAll(async () => {
  db = await portableDatabase();
  f = await fixture(db);
  const supabase = {
    auth: {
      getUser: async (token: string) => ({
        data: { user: { id: f[token as 'admin'] } },
        error: null,
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
    { ...poolAdapters(db), supabase: withProviderSessions(db, supabase) },
  );
  // Establish the fixture login before comparing admission-only audit changes.
  expect((await call('get', '/student-directory/classes')).status).toBe(200);
});
afterAll(async () => db.close());

it('previews all admission fields without saving any students, families, accounts or audits', async () => {
  const before = await counts();
  const result = await call('post', '/student-directory/imports').send({
    rows: [row('CSV_PREVIEW')],
    validate_only: true,
  });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect(result.body).toEqual({ validated: 1, imported: 0 });
  expect(await counts()).toEqual(before);
});
it('atomically imports complete student, enrollment and multiple guardian details with safe retries', async () => {
  const body = {
    ...row('CSV_FULL'),
    parent_2_mode: 'EXISTING',
    parent_2_email: 'parent@example.invalid',
    parent_2_relationship: 'FATHER',
    parent_2_is_primary_contact: false,
    parent_2_can_receive_alerts: true,
  };
  const key = crypto.randomUUID(),
    result = await commit([body], key);
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  const stored = (
    await db.query(
      `SELECT s.id,s.email::text,s.gender,s.user_id,e.class_id,e.academic_session_id,e.roll_number
    FROM students s JOIN enrollments e ON e.school_id=s.school_id AND e.student_id=s.id WHERE s.school_id=$1 AND s.student_code='CSV_FULL'`,
      [f.schoolA],
    )
  ).rows[0];
  expect(stored).toMatchObject({
    email: body.email,
    gender: 'FEMALE',
    user_id: null,
    class_id: f.classId,
    academic_session_id: f.session,
    roll_number: 'CSV_FULL',
  });
  const family = (
    await db.query(
      'SELECT p.full_name,p.phone,sp.relationship,sp.is_primary_contact,sp.can_receive_alerts FROM student_parents sp JOIN parents p ON p.school_id=sp.school_id AND p.id=sp.parent_id WHERE sp.school_id=$1 AND sp.student_id=$2 ORDER BY sp.is_primary_contact DESC',
      [f.schoolA, stored.id],
    )
  ).rows;
  expect(family).toHaveLength(2);
  expect(family[0]).toMatchObject({
    full_name: body.parent_1_full_name,
    phone: body.parent_1_phone,
    relationship: 'MOTHER',
    is_primary_contact: true,
    can_receive_alerts: false,
  });
  const after = await counts();
  expect((await commit([body], key)).body).toEqual(result.body);
  expect(await counts()).toEqual(after);
  expect((await commit([{ ...body, first_name: 'Changed' }], key)).status).toBe(409);
});
it('reuses a newly created parent explicitly across sibling rows, without duplicate parent records', async () => {
  const sibling = {
    ...row('CSV_SIBLING_2'),
    parent_1_mode: 'EXISTING',
    parent_1_email: 'csv_sibling_1-parent@example.test',
  } as Record<string, unknown>;
  delete sibling.parent_1_full_name;
  delete sibling.parent_1_phone;
  const result = await commit([row('CSV_SIBLING_1'), sibling]);
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  expect(
    (
      await db.query(
        "SELECT id FROM parents WHERE school_id=$1 AND email='csv_sibling_1-parent@example.test'",
        [f.schoolA],
      )
    ).rows,
  ).toHaveLength(1);
  expect(
    (
      await db.query(
        "SELECT sp.id FROM student_parents sp JOIN parents p ON p.school_id=sp.school_id AND p.id=sp.parent_id WHERE p.school_id=$1 AND p.email='csv_sibling_1-parent@example.test'",
        [f.schoolA],
      )
    ).rows,
  ).toHaveLength(2);
});
it('rolls back the whole file, including successful earlier rows and audits, when any row is invalid', async () => {
  const before = await counts();
  const result = await commit([
    row('CSV_ROLLBACK'),
    { ...row('CSV_BAD_DATE'), starts_on: '2026-02-30' },
    { ...row('CSV_BAD_CLASS'), class_section: 'MISSING' },
  ]);
  expect(result.status).toBe(422);
  expect(result.body.error.details.map((v: any) => v.row)).toEqual([2, 3]);
  expect(await counts()).toEqual(before);
});
it('rejects duplicate students, reused NEW parent emails, duplicate guardians and multiple primary contacts without overwriting records', async () => {
  for (const rows of [
    [row('CSV_DUP'), row('CSV_DUP')],
    [{ ...row('CSV_PARENT_DUP'), parent_1_email: 'parent@example.invalid' }],
    [
      {
        ...row('CSV_REPEAT_GUARDIAN'),
        parent_1_mode: 'EXISTING',
        parent_1_full_name: undefined,
        parent_1_phone: undefined,
        parent_1_email: 'parent@example.invalid',
        parent_2_mode: 'EXISTING',
        parent_2_email: 'parent@example.invalid',
      },
    ],
    [
      {
        ...row('CSV_PRIMARY'),
        parent_2_mode: 'EXISTING',
        parent_2_email: 'parent@example.invalid',
        parent_2_is_primary_contact: true,
      },
    ],
  ]) {
    const before = await counts();
    expect((await commit(rows)).status).toBe(422);
    expect(await counts()).toEqual(before);
  }
});
it('rejects hidden IDs, role/account injections, missing parents and invalid contact flags', async () => {
  for (const patch of [
    { user_id: f.parent },
    { school_id: f.schoolB },
    { parent_1_can_receive_alerts: 'yes' },
    { parent_1_mode: 'EXISTING' },
    { parent_1_full_name: undefined, parent_1_email: undefined, parent_1_phone: undefined },
  ]) {
    const before = await counts();
    expect((await commit([{ ...row('CSV_INVALID'), ...patch }])).status).toBe(422);
    expect(await counts()).toEqual(before);
  }
  expect(
    (
      await call('post', '/student-directory/imports').send({
        rows: [row('CSV_NO_KEY')],
        validate_only: false,
      })
    ).status,
  ).toBe(422);
});
it('enforces School Admin permissions and school isolation for import and export', async () => {
  for (const role of ['principal', 'teacher', 'parent', 'studentUser']) {
    expect(
      (
        await call('post', '/student-directory/imports', role).send({
          rows: [row('DENIED')],
          validate_only: true,
        })
      ).status,
    ).toBe(403);
    expect((await call('get', '/student-directory/export.csv', role)).status).toBe(403);
  }
  expect((await call('get', '/student-directory/export.csv', 'admin', f.schoolB)).status).toBe(404);
  await db.query(
    "INSERT INTO parents(school_id,full_name,email) VALUES($1,'Foreign parent','foreign-parent@example.test')",
    [f.schoolB],
  );
  const result = await commit([
    {
      ...row('CSV_FOREIGN'),
      parent_1_mode: 'EXISTING',
      parent_1_full_name: undefined,
      parent_1_phone: undefined,
      parent_1_email: 'foreign-parent@example.test',
    },
  ]);
  expect(result.status).toBe(422);
  expect(JSON.stringify(result.body)).not.toContain('Foreign parent');
});
it('exports full school student records and family flags, including inactive/unassigned students, with spreadsheet formula protection', async () => {
  await db.query(
    "INSERT INTO students(school_id,student_code,first_name,status) VALUES($1,'CSV_UNASSIGNED','=UNTRUSTED()','WITHDRAWN')",
    [f.schoolA],
  );
  const result = await call('get', '/student-directory/export.csv');
  expect(result.status, result.text).toBe(200);
  expect(result.headers['content-type']).toContain('text/csv');
  expect(result.headers['content-disposition']).toContain('attachment');
  expect(result.headers['cache-control']).toBe('no-store');
  const [header, ...rows] = parseCsv(result.text);
  const record = rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
  expect(record.find((r) => r.student_code === 'CSV_FULL')).toMatchObject({
    class_grade: '8',
    class_section: 'A',
    gender: 'FEMALE',
    academic_session: 'Test year',
    parent_1_full_name: 'Parent CSV_FULL',
    parent_1_can_receive_alerts: 'false',
    parent_2_full_name: 'Parent Test',
  });
  expect(record.find((r) => r.student_code === 'CSV_UNASSIGNED')).toMatchObject({
    first_name: "'=UNTRUSTED()",
    status: 'WITHDRAWN',
    class_grade: '',
  });
  expect(result.text).not.toContain('Foreign learner');
  expect(result.text).not.toContain('foreign-parent@example.test');
  const filtered = await call(
    'get',
    `/student-directory/export.csv?search=CSV_FULL&academic_session_id=${f.session}`,
  );
  expect(parseCsv(filtered.text)).toHaveLength(2);
});
it('streams beyond a single page and preserves revoked family history beyond the two active-parent limit', async () => {
  await db.query(
    "INSERT INTO students(school_id,student_code,first_name) SELECT $1,'CSV_PAGE_'||n,'Export learner' FROM generate_series(1,505) n",
    [f.schoolA],
  );
  for (let i = 1; i <= 6; i++) {
    const parent = (
      await db.query('INSERT INTO parents(school_id,full_name) VALUES($1,$2) RETURNING id', [
        f.schoolA,
        `Extra guardian ${i}`,
      ])
    ).rows[0].id;
    await db.query(
      "INSERT INTO student_parents(school_id,student_id,parent_id,relationship,status) VALUES($1,$2,$3,'OTHER',$4)",
      [f.schoolA, f.student, parent, i === 1 ? 'ACTIVE' : 'REVOKED'],
    );
  }
  const result = await call('get', '/student-directory/export.csv');
  expect(result.status).toBe(200);
  const [header, ...rows] = parseCsv(result.text);
  expect(
    rows.filter((r) => r[header.indexOf('student_code')].startsWith('CSV_PAGE_')),
  ).toHaveLength(505);
  expect(header).toContain('parent_7_full_name');
  expect(result.text).toContain('Extra guardian 6');
  expect(result.text).toContain('REVOKED');
});
it('honors student limits and read-only subscriptions on validation and commit', async () => {
  const limits = (
    await db.query(
      'SELECT limits FROM subscription_plans WHERE id=(SELECT plan_id FROM subscriptions WHERE school_id=$1)',
      [f.schoolA],
    )
  ).rows[0].limits;
  await db.query(
    'UPDATE subscription_plans SET limits=limits||$2::jsonb WHERE id=(SELECT plan_id FROM subscriptions WHERE school_id=$1)',
    [f.schoolA, { max_students: 1 }],
  );
  const before = await counts();
  const quota = await commit([row('CSV_QUOTA')]);
  expect(quota.status).toBe(422);
  expect(JSON.stringify(quota.body)).toContain('student limit');
  expect(await counts()).toEqual(before);
  await db.query(
    'UPDATE subscription_plans SET limits=$2 WHERE id=(SELECT plan_id FROM subscriptions WHERE school_id=$1)',
    [f.schoolA, limits],
  );
  await db.query("UPDATE subscriptions SET status='SUSPENDED' WHERE school_id=$1", [f.schoolA]);
  expect((await commit([row('CSV_READONLY')])).status).toBe(403);
  expect(
    (
      await call('post', '/student-directory/imports').send({
        rows: [row('CSV_READONLY')],
        validate_only: true,
      })
    ).status,
  ).toBe(403);
  await db.query("UPDATE subscriptions SET status='ACTIVE' WHERE school_id=$1", [f.schoolA]);
});
