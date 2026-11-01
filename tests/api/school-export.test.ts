import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { portableDatabase, poolAdapters, fixture } from '../helpers/database.js';
import { generateSchoolExport } from '../../apps/worker/src/school-exports.js';
const errors = vi.hoisted(() => [] as unknown[]);
vi.mock('../../apps/api/src/lib/monitoring.js', () => ({
  captureFailure: (error: unknown) => errors.push(error),
}));
let db: PGlite, pools: ReturnType<typeof poolAdapters>, f: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => {
  db = await portableDatabase();
  pools = poolAdapters(db);
  f = await fixture(db);
});
afterAll(async () => {
  await db.close();
});
it('exports a complete private school snapshot without foreign students or credentials', async () => {
  await db.query('UPDATE schools SET profile=$2 WHERE id=$1', [
    f.schoolA,
    { city: 'Own school city' },
  ]);
  await db.query('INSERT INTO school_profile_private(school_id,details) VALUES($1,$2),($3,$4)', [
    f.schoolA,
    { management_name: 'Own education trust' },
    f.schoolB,
    { management_name: 'Foreign private management' },
  ]);
  const files = new Map<string, Buffer>();
  const storage = {
    storage: {
      from: () => ({
        upload: async (path: string, b: Buffer) => {
          files.set(path, Buffer.from(b));
          return { error: null };
        },
        download: async () => ({ error: { message: 'not expected' } }),
        remove: async (paths: string[]) => {
          paths.forEach((p) => files.delete(p));
          return { error: null };
        },
      }),
    },
  } as unknown as SupabaseClient;
  const job = (
    await db.query<{ id: string }>(
      "INSERT INTO school_exports(school_id,requested_by,format) VALUES($1,$2,'JSON') RETURNING id",
      [f.schoolA, f.admin],
    )
  ).rows[0];
  await generateSchoolExport(pools.worker, f.schoolA, storage);
  const result = (
    await db.query<{
      status: string;
      error_code: string | null;
      manifest: { name: string; path: string; sha256: string }[];
    }>('SELECT status,error_code,manifest FROM school_exports WHERE id=$1', [job.id])
  ).rows[0];
  expect(errors).toEqual([]);
  expect(result.error_code).toBeNull();
  expect(result.status).toBe('COMPLETED');
  const students = result.manifest.find((x) => x.name.startsWith('students-'));
  expect(students).toBeDefined();
  const data = JSON.parse(files.get(students!.path)!.toString());
  expect(data.map((x: { id: string }) => x.id)).toEqual([f.student]);
  expect([...files.keys()].every((p) => p.startsWith(f.schoolA + '/exports/' + job.id + '/'))).toBe(
    true,
  );
  expect(result.manifest.every((x) => /^[a-f0-9]{64}$/.test(x.sha256))).toBe(true);
  const whole = [...files.values()].map((b) => b.toString()).join('');
  expect(whole).not.toContain(f.foreignStudent);
  expect(whole).not.toContain('token_encrypted');
  expect(whole).not.toContain('secret_hash');
  expect(whole).toContain('Own school city');
  expect(whole).toContain('Own education trust');
  expect(whole).not.toContain('Foreign private management');
});
