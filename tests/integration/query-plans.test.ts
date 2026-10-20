import { beforeAll, afterAll, it, expect } from 'vitest';
import pg from 'pg';
import type { PGlite } from '@electric-sql/pglite';
import { writeFile } from 'node:fs/promises';
import { fixture } from '../helpers/database.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { generateReports } from '../../apps/worker/src/reports.js';
const url = process.env.TEST_DATABASE_URL;
let pool: pg.Pool, f: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => {
  if (!url) return;
  const target = new URL(url);
  if (!target.pathname.endsWith('_test') || !['localhost', '127.0.0.1'].includes(target.hostname))
    throw new Error('LOCAL_ISOLATED_TEST_DATABASE_REQUIRED');
  pool = new pg.Pool({ connectionString: url, ssl: false });
  f = await fixture(pool as unknown as Pick<PGlite, 'query'>);
  await pool.query(
    "INSERT INTO students(school_id,student_code,first_name) SELECT $1,'PERF_'||n,'Synthetic learner '||n FROM generate_series(1,1000) n",
    [f.schoolA],
  );
  await pool.query(
    "INSERT INTO enrollments(school_id,student_id,class_id,academic_session_id,starts_on) SELECT $1,id,$2,$3,'2026-01-01' FROM students WHERE school_id=$1 AND student_code LIKE 'PERF_%'",
    [f.schoolA, f.classId, f.session],
  );
  await pool.query(
    "INSERT INTO daily_attendance(school_id,student_id,class_id,academic_session_id,attendance_date,attendance_status) SELECT $1,s.id,$2,$3,date '2026-09-01'+day,'PRESENT' FROM students s CROSS JOIN generate_series(0,29) day WHERE s.school_id=$1 AND s.student_code LIKE 'PERF_%'",
    [f.schoolA, f.classId, f.session],
  );
  await pool.query('ANALYZE students;ANALYZE enrollments;ANALYZE daily_attendance');
}, 60000);
afterAll(async () => pool?.end());
it.skipIf(!url)(
  'records indexed tenant-scoped query plans on 1,000 learners and 30,000 attendance rows',
  async () => {
    const student = (
      await pool.query("SELECT id FROM students WHERE school_id=$1 AND student_code='PERF_1'", [
        f.schoolA,
      ])
    ).rows[0].id;
    const client = await pool.connect();
    let plan: any;
    try {
      await client.query('BEGIN;SET LOCAL ROLE app_api');
      await client.query(
        "SELECT set_config('app.school_id',$1,true),set_config('app.user_id',$2,true),set_config('app.actor_type','USER',true)",
        [f.schoolA, f.admin],
      );
      plan = (
        await client.query(
          "EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT attendance_date,attendance_status FROM daily_attendance WHERE school_id=$1 AND student_id=$2 AND attendance_date BETWEEN '2026-09-01' AND '2026-09-30' ORDER BY attendance_date",
          [f.schoolA, student],
        )
      ).rows[0]['QUERY PLAN'][0];
      expect(JSON.stringify(plan.Plan)).toMatch(/Index|Bitmap/);
      expect(plan.Plan['Actual Rows']).toBe(30);
      expect(
        (await client.query('SELECT id FROM students WHERE id=$1', [f.foreignStudent])).rows,
      ).toHaveLength(0);
      await client.query('ROLLBACK');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    await writeFile(
      'output/native-queryplans-evidence.json',
      JSON.stringify(
        {
          date: new Date().toISOString(),
          environment: 'Disposable local PostgreSQL 17; synthetic records; no cloud SLO claim',
          learners: 1000,
          attendance_rows: 30000,
          query: 'Tenant/student/month attendance with forced RLS',
          execution_ms: plan['Execution Time'],
          planning_ms: plan['Planning Time'],
          plan: plan.Plan,
        },
        null,
        2,
      ) + '\n',
    );
  },
);
it.skipIf(!url)(
  'generates a private 1,000-student attendance PDF through the worker role',
  async () => {
    const report = (
      await pool.query(
        "INSERT INTO report_documents(school_id,kind,parameters,requested_by) VALUES($1,'ATTENDANCE',$2,$3) RETURNING id",
        [f.schoolA, { from: '2026-09-01', to: '2026-09-01', format: 'PDF' }, f.admin],
      )
    ).rows[0].id;
    let bytes = 0;
    const storage = {
      storage: {
        from: () => ({
          upload: async (_path: string, data: Buffer) => {
            expect(data.subarray(0, 4).toString()).toBe('%PDF');
            bytes = data.length;
            return { error: null };
          },
        }),
      },
    } as unknown as SupabaseClient;
    const worker = new pg.Pool({
      connectionString: url,
      ssl: false,
      options: '-c role=app_worker',
    });
    try {
      await generateReports(worker, f.schoolA, storage);
    } finally {
      await worker.end();
    }
    expect(bytes).toBeGreaterThan(10000);
    expect(
      (await pool.query('SELECT status,error_code FROM report_documents WHERE id=$1', [report]))
        .rows[0],
    ).toEqual({ status: 'COMPLETED', error_code: null });
  },
);
