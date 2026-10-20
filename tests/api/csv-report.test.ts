import { beforeAll, afterAll, it, expect } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { portableDatabase, poolAdapters, fixture } from '../helpers/database.js';
import { generateReports } from '../../apps/worker/src/reports.js';
let db: PGlite, pools: ReturnType<typeof poolAdapters>, f: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => {
  db = await portableDatabase();
  pools = poolAdapters(db);
  f = await fixture(db);
});
afterAll(async () => db.close());
it('exports more than 10,000 authorized rows through the streamed CSV path, with formula neutralization', async () => {
  await db.query(
    "INSERT INTO fee_records(school_id,student_id,academic_session_id,status,fee_type,amount_due,due_on) SELECT $1,$2,$3,'UNPAID',CASE WHEN n=1 THEN ' =2+2' ELSE 'Fee '||n END,100,'2026-01-01' FROM generate_series(1,10001) n",
    [f.schoolA, f.student, f.session],
  );
  const foreignSession = crypto.randomUUID();
  await db.query(
    "INSERT INTO academic_sessions(id,school_id,name,starts_on,ends_on) VALUES($1,$2,'Foreign fixture','2026-01-01','2026-12-31')",
    [foreignSession, f.schoolB],
  );
  await db.query(
    "INSERT INTO fee_records(school_id,student_id,academic_session_id,status,fee_type,amount_due,due_on) VALUES($1,$2,$3,'UNPAID','Foreign private fee',500,'2026-01-01')",
    [f.schoolB, f.foreignStudent, foreignSession],
  );
  expect(
    Number(
      (
        await db.query<{ file_size_limit: number }>(
          "SELECT file_size_limit FROM storage.buckets WHERE id='school-documents'",
        )
      ).rows[0].file_size_limit,
    ),
  ).toBeGreaterThanOrEqual(19 * 1024 * 1024);
  const id = (
    await db.query<{ id: string }>(
      "INSERT INTO report_documents(school_id,kind,parameters,requested_by) VALUES($1,'FEES',$2,$3) RETURNING id",
      [f.schoolA, { format: 'CSV', from: '2026-01-01', to: '2026-12-31' }, f.admin],
    )
  ).rows[0].id;
  let body = '',
    path = '';
  const storage = {
    storage: {
      from: () => ({
        upload: async (p: string, b: Blob) => {
          path = p;
          expect(b).toBeInstanceOf(Blob);
          body = await b.text();
          return { error: null };
        },
      }),
    },
  } as unknown as SupabaseClient;
  await generateReports(pools.worker, f.schoolA, storage);
  const job = (
    await db.query<{ status: string; error_code: string | null }>(
      'SELECT status,error_code FROM report_documents WHERE id=$1',
      [id],
    )
  ).rows[0];
  expect(job).toEqual({ status: 'COMPLETED', error_code: null });
  expect(path).toMatch(/\.csv$/);
  expect(body.split('\r\n')).toHaveLength(10003);
  expect(body).not.toContain('Foreign private fee');
  expect(body).toContain('"\' =2+2"');
}, 60000);
