import { afterAll, beforeAll, expect, it } from 'vitest';
import request from 'supertest';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { strToU8, zipSync } from 'fflate';
import sharp from 'sharp';
import { createApp } from '../../apps/api/src/app.js';
import type { Config } from '../../apps/api/src/lib/config.js';
import { transaction } from '../../apps/api/src/lib/db.js';
import { fixture, poolAdapters, portableDatabase } from '../helpers/database.js';
import { fixtureBearer, withProviderSessions } from '../helpers/provider-sessions.js';

let db: PGlite;
let f: Awaited<ReturnType<typeof fixture>>;
let pools: ReturnType<typeof poolAdapters>;
let app: ReturnType<typeof createApp>;
let png: Buffer;
const objects = new Map<string, Buffer>();
const call = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, role = 'admin') =>
  request(app)
    [method]('/api/v1' + path)
    .set('Authorization', 'Bearer ' + fixtureBearer(role))
    .set('X-School-Id', f.schoolA);
const photo = (id: string, expected = '', replace = false, data = png, role = 'admin') =>
  call('put', `/profiles/student/${id}/photo`, role)
    .field('expected_photo_id', expected)
    .field('replace', String(replace))
    .attach('image', data, 'portrait.png');
const archive = (files: Record<string, Uint8Array>) => Buffer.from(zipSync(files));
const preview = (data: Buffer, kind = 'student') =>
  call('post', `/profiles/${kind}/photos/preview`).attach('archive', data, 'photos.zip');
const importPhotos = (file: Buffer, manifest: Record<string, unknown>, kind = 'student') =>
  call('post', `/profiles/${kind}/photos/import`)
    .field('manifest', JSON.stringify(manifest))
    .attach('archive', file, 'photos.zip');

beforeAll(async () => {
  db = await portableDatabase();
  f = await fixture(db);
  pools = poolAdapters(db);
  png = await sharp({ create: { width: 64, height: 80, channels: 3, background: '#88cc00' } })
    .png()
    .toBuffer();
  const supabase = {
    auth: {
      getUser: async (token: string) => ({
        data: { user: { id: f[token as 'admin'] } },
        error: null,
      }),
    },
    storage: {
      from: (name: string) => {
        expect(name).toBe('school-documents');
        return {
          upload: async (path: string, bytes: Buffer) => {
            objects.set(path, bytes);
            return { error: null };
          },
          remove: async (paths: string[]) => {
            for (const path of paths) objects.delete(path);
            return { error: null };
          },
          download: async (path: string) => {
            const data = objects.get(path);
            return data
              ? { data: new Blob([new Uint8Array(data)]), error: null }
              : { data: null, error: true };
          },
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
      PROFILE_PHOTO_MAX_BYTES: 65536,
    } as Config,
    { ...pools, supabase: withProviderSessions(db, supabase) },
  );
});
afterAll(async () => db?.close());

it('stores sanitized photos privately, checks access, and requires a matching revision for replacement and removal', async () => {
  expect((await photo(f.student, '', false, Buffer.from('<svg/>'))).status).toBe(422);
  expect((await photo(f.student, '', false, Buffer.alloc(70_000))).status).toBe(413);
  expect((await photo(f.student, '', false, png, 'studentUser')).status).toBe(403);
  expect((await photo(f.foreignStudent)).status).toBe(404);
  const created = await photo(f.student);
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const url = `/profiles/student/${f.student}/photo/${created.body.photo_id}`;
  const image = await call('get', url, 'parent');
  expect(image.status, JSON.stringify(image.body)).toBe(200);
  expect(image.headers['cache-control']).toContain('no-store');
  const metadata = await sharp(image.body).metadata();
  expect(metadata.format).toBe('jpeg');
  expect(metadata.exif).toBeUndefined();
  expect((await call('get', url, 'studentUser')).status).toBe(200);
  expect((await call('get', url, 'teacher')).status).toBe(200);
  expect(
    (
      await call(
        'get',
        `/profiles/student/${f.foreignStudent}/photo/${created.body.photo_id}`,
        'parent',
      )
    ).status,
  ).toBe(404);
  expect((await photo(f.student, created.body.photo_id)).body.error.code).toBe(
    'CONFIRM_PHOTO_REPLACEMENT',
  );
  expect((await photo(f.student)).body.error.code).toBe('PROFILE_PHOTO_CHANGED');
  const replaced = await photo(f.student, created.body.photo_id, true);
  expect(replaced.status).toBe(200);
  expect((await call('get', url)).status).toBe(404);
  expect(objects.size).toBe(1);
  expect(
    (
      await call('delete', `/profiles/student/${f.student}/photo`).send({
        expected_photo_id: replaced.body.photo_id,
      })
    ).status,
  ).toBe(200);
  expect(objects.size).toBe(0);
});

it('protects full staff records, lets members read their own, and links a legacy active membership safely', async () => {
  const staffPath = `/profiles/staff/${f.teacherId}`;
  const details = {
    designation: 'Senior teacher',
    department: 'Math',
    qualification: 'M.Ed',
    experience_years: 8.5,
    joined_on: '2020-06-02',
    emergency_phone: '+91 90000 10000',
    address: 'Private home address',
  };
  expect((await call('patch', staffPath, 'teacher').send(details)).status).toBe(403);
  expect((await call('patch', staffPath).send(details)).status).toBe(200);
  const own = await call('get', '/profiles/staff/me', 'teacher');
  expect(own.status, JSON.stringify(own.body)).toBe(200);
  expect(own.body.details).toEqual(details);
  expect(own.body.assignments).toContainEqual(
    expect.objectContaining({ grade: '8', subject: 'Mathematics' }),
  );
  expect((await call('get', staffPath, 'principal')).status).toBe(404);
  expect((await call('get', staffPath, 'studentUser')).status).toBe(403);
  expect(JSON.stringify((await call('get', '/resources/teachers')).body)).not.toContain(
    'Private home address',
  );
  await transaction(pools.api, { schoolId: f.schoolA, userId: f.principal }, async (tx) => {
    expect((await tx.query('SELECT details FROM school_person_details')).rows).toEqual([]);
  });
  const membership = (
    await db.query<{ id: string }>(
      'SELECT id FROM school_memberships WHERE school_id=$1 AND user_id=$2',
      [f.schoolA, f.principal],
    )
  ).rows[0].id;
  const linked = await call('post', `/profiles/staff/from-membership/${membership}`).send({
    employee_id: 'P001',
  });
  expect(linked.status, JSON.stringify(linked.body)).toBe(201);
  expect(
    (
      await call('post', `/profiles/staff/from-membership/${membership}`).send({
        employee_id: 'P001',
      })
    ).body.id,
  ).toBe(linked.body.id);
  expect((await call('get', '/profiles/staff/me', 'principal')).body.staff_code).toBe('P001');
});

it('previews valid, duplicate, unmatched and missing photos, supports manual matching, and keeps tenant scope at commit', async () => {
  const dupZip = archive({
    'STU001.png': png,
    'dup/stu001.png': png,
    'FOREIGN.png': png,
    'bad.png': strToU8('not a PNG'),
  });
  const reviewed = await preview(dupZip);
  expect(reviewed.status, JSON.stringify(reviewed.body)).toBe(200);
  expect(reviewed.body.missing).toBe(1);
  expect(reviewed.body.photos).toEqual([
    expect.objectContaining({ filename: 'STU001.png', duplicate: true }),
    expect.objectContaining({ filename: 'stu001.png', duplicate: true }),
    expect.objectContaining({ filename: 'FOREIGN.png', duplicate: false }),
    expect.objectContaining({
      filename: 'bad.png',
      issue: 'Invalid or unsupported image contents',
    }),
  ]);
  expect(reviewed.body.photos.every((row: { matched?: string }) => !row.matched)).toBe(true);
  expect((await preview(archive({ '../escape.png': png }))).status).toBe(422);
  const matched = await preview(archive({ 'STU001.png': png }));
  expect(matched.body.photos[0].matched).toBe(f.student);
  const manifest = {
    archive_hash: reviewed.body.archive_hash,
    assignments: [
      { index: 0, person_id: f.student, expected_photo_id: null, replace: false },
      { index: 2, person_id: f.foreignStudent, expected_photo_id: null, replace: false },
    ],
  };
  expect((await importPhotos(archive({ 'STU001.png': png }), manifest)).status).toBe(409);
  const saved = await importPhotos(dupZip, manifest);
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  expect(saved.body).toMatchObject({
    saved: 1,
    failed: [expect.objectContaining({ index: 2 })],
    missing: 0,
  });
  const staffZip = archive({ 'T1.png': png });
  const staffReview = await preview(staffZip, 'staff');
  expect(staffReview.body.photos[0].matched).toBe(f.teacherId);
  expect(
    (
      await importPhotos(
        staffZip,
        {
          archive_hash: staffReview.body.archive_hash,
          assignments: [
            { index: 0, person_id: f.teacherId, expected_photo_id: null, replace: false },
          ],
        },
        'staff',
      )
    ).body.saved,
  ).toBe(1);
});

function staffWorkbook(cell = 'A2') {
  const ns = 'http://schemas.openxmlformats.org';
  return archive({
    '[Content_Types].xml': strToU8(
      `<Types xmlns="${ns}/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    ),
    '_rels/.rels': strToU8(
      `<Relationships xmlns="${ns}/package/2006/relationships"><Relationship Id="rId1" Type="${ns}/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    'xl/workbook.xml': strToU8(
      `<workbook xmlns="${ns}/spreadsheetml/2006/main" xmlns:r="${ns}/officeDocument/2006/relationships"><sheets><sheet name="Staff" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `<Relationships xmlns="${ns}/package/2006/relationships"><Relationship Id="rId1" Type="${ns}/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    ),
    'xl/worksheets/sheet1.xml': strToU8(
      `<worksheet xmlns="${ns}/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>staff_code</t></is></c><c r="B1" t="inlineStr"><is><t>full_name</t></is></c></row><row r="2"><c r="${cell}" t="inlineStr"><is><t>0007</t></is></c><c r="B2" t="inlineStr"><is><t>New Employee</t></is></c></row></sheetData></worksheet>`,
    ),
  });
}

it('reads Excel text IDs without losing leading zeros, and imports staff fields atomically without duplicates', async () => {
  const parse = (file: Buffer) =>
    call('post', '/profiles/staff/workbook').attach('workbook', file, 'staff.xlsx');
  const parsed = await parse(staffWorkbook());
  expect(parsed.status, JSON.stringify(parsed.body)).toBe(200);
  expect(parsed.body.csv).toBe('"staff_code","full_name"\r\n"0007","New Employee"');
  expect((await parse(staffWorkbook('XFD1048576'))).status).toBe(422);
  const entry = {
    staff_code: '0007',
    full_name: 'New Employee',
    designation: 'Teaching assistant',
    experience_years: '2.5',
  };
  const importStaff = (rows: unknown[], validate_only = false) =>
    call('post', '/imports/teachers')
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ rows, validate_only });
  expect((await importStaff([entry], true)).body).toEqual({ validated: 1, imported: 0 });
  expect((await importStaff([entry])).body).toEqual({ validated: 1, imported: 1 });
  expect((await importStaff([{ ...entry, staff_code: '0008' }, entry])).status).toBe(422);
  const data = await db.query(
    `SELECT t.staff_code,d.details FROM teachers t JOIN school_person_details d ON d.school_id=t.school_id
    AND d.staff_id=t.id WHERE t.school_id=$1 AND t.staff_code IN ('0007','0008')`,
    [f.schoolA],
  );
  expect(data.rows).toEqual([
    { staff_code: '0007', details: { designation: 'Teaching assistant', experience_years: 2.5 } },
  ]);
  expect((await importStaff([{ ...entry, staff_code: 't1' }])).status).toBe(422);
});
