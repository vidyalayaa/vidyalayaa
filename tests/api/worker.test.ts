import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { portableDatabase, poolAdapters, fixture } from '../helpers/database.js';
import { drainOutbox } from '../../apps/worker/src/outbox.js';
import { scheduledJobs } from '../../apps/worker/src/jobs.js';
import { queue } from '../../apps/api/src/modules/attendance/service.js';
import { transaction } from '../../apps/api/src/lib/db.js';
import { sampleRule } from '../../apps/web/src/features/resources/metadata.js';
let db: PGlite, pools: ReturnType<typeof poolAdapters>, f: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => {
  db = await portableDatabase();
  pools = poolAdapters(db);
  f = await fixture(db);
  await db.query(
    "INSERT INTO attendance_rule_versions(school_id,day_type,version_no,effective_from,rules,created_by) VALUES($1,'REGULAR',1,'2026-01-01',$2,$3)",
    [f.schoolA, JSON.stringify({ ...sampleRule, weekly_off: [] }), f.admin],
  );
});
afterAll(async () => {
  vi.useRealTimers();
  await db.close();
});
it('TEST-REQ-021 retains the outbox and records independent channel failures without touching attendance', async () => {
  await transaction(pools.device, { schoolId: f.schoolA }, (tx) =>
    queue(tx, f.schoolA, f.student, 'STUDENT_ARRIVED', 'arrival-test', {
      event_time: new Date().toISOString(),
    }),
  );
  await drainOutbox(pools.worker, f.schoolA, 'ab'.repeat(32));
  const deliveries = await db.query<{ status: string; channel: string }>(
    'SELECT status,channel FROM notification_deliveries WHERE school_id=$1',
    [f.schoolA],
  );
  expect(deliveries.rows.find((x) => x.channel === 'EMAIL')?.status).toBe('FAILED');
  expect(deliveries.rows.find((x) => x.channel === 'SMS')?.status).toBe('SUPPRESSED');
  expect(
    (
      await db.query<{ status: string }>(
        "SELECT status FROM notification_outbox WHERE dedupe_key='arrival-test'",
      )
    ).rows[0].status,
  ).toBe('PENDING');
  expect((await db.query('SELECT * FROM notification_attempts')).rows.length).toBeGreaterThan(0);
});
it('TEST-REQ-034 defers absence while offline, then finalizes provisionally at the hard limit', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-17T07:15:00Z'));
  await scheduledJobs(pools.worker, f.schoolA);
  expect(
    (
      await db.query<{ attendance_status: string }>(
        'SELECT attendance_status FROM daily_attendance WHERE school_id=$1 AND student_id=$2',
        [f.schoolA, f.student],
      )
    ).rows[0].attendance_status,
  ).toBe('PENDING');
  vi.setSystemTime(new Date('2026-10-17T10:01:00Z'));
  await scheduledJobs(pools.worker, f.schoolA);
  const day = (
    await db.query<{ attendance_status: string; provisional: boolean }>(
      'SELECT attendance_status,provisional FROM daily_attendance WHERE school_id=$1 AND student_id=$2',
      [f.schoolA, f.student],
    )
  ).rows[0];
  expect(day.attendance_status).toBe('ABSENT');
  expect(day.provisional).toBe(true);
  expect(
    (await db.query("SELECT * FROM notification_outbox WHERE kind='STUDENT_ABSENT'")).rows,
  ).toHaveLength(1);
  vi.useRealTimers();
});
