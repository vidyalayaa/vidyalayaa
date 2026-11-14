import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { portableDatabase, poolAdapters, fixture } from '../helpers/database.js';
import { drainOutbox } from '../../apps/worker/src/outbox.js';
import { scheduledJobs } from '../../apps/worker/src/jobs.js';
import { processEvent, queue } from '../../apps/api/src/modules/attendance/service.js';
import { transaction } from '../../apps/api/src/lib/db.js';
import { sampleRule } from '../../apps/web/src/features/resources/metadata.js';
import { sendPushTargets } from '../../apps/worker/src/push-targets.js';
import * as providers from '../../apps/worker/src/providers.js';
import { academicSummaries, generateReports } from '../../apps/worker/src/reports.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { messageFor } from '../../apps/worker/src/outbox.js';
import { encrypt } from '../../apps/api/src/lib/crypto.js';
import { applyRetention } from '../../apps/worker/src/retention.js';
import { monitorWorker, pruneWorkerInstances } from '../../apps/worker/src/health.js';
import { defaultSchoolTimings } from '@vidyalayaa/contracts';
import type { Actor } from '../../apps/api/src/middleware/auth.js';
import { markManualAttendance } from '../../apps/api/src/modules/school/manual-attendance.js';
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
  vi.restoreAllMocks();
  vi.useRealTimers();
  await db.close();
});
it('prunes old and stopped worker records while retaining recent heartbeats', async () => {
  const [running, degraded, old, stopped] = Array.from({ length: 4 }, () => crypto.randomUUID());
  await db.query(
    `INSERT INTO worker_instances(id,state,last_seen_at) VALUES
      ($1,'RUNNING',now()), ($2,'DEGRADED',now()),
      ($3,'RUNNING',now()-interval '2 minutes'), ($4,'STOPPING',now())`,
    [running, degraded, old, stopped],
  );
  expect(await pruneWorkerInstances(pools.worker)).toBe(2);
  const result = await db.query<{ id: string }>('SELECT id FROM worker_instances');
  expect(result.rows.map(({ id }) => id).sort()).toEqual([running, degraded].sort());
});
it('keeps a configured worker name on its heartbeat after a successful cycle', async () => {
  const id = crypto.randomUUID();
  vi.stubEnv('WORKER_INSTANCE_ID', id);
  vi.stubEnv('WORKER_NAME', ' Voroa worker ');
  try {
    const worker = await monitorWorker(pools.worker);
    try {
      await worker.cycle(true);
      expect(
        (await db.query('SELECT worker_name,state FROM worker_instances WHERE id=$1', [id])).rows,
      ).toEqual([{ worker_name: 'Voroa worker', state: 'RUNNING' }]);
    } finally {
      await worker.stop();
    }
  } finally {
    vi.unstubAllEnvs();
  }
});
it('isolates invalid push tokens and skips successful targets on transient retries', async () => {
  const outbox = crypto.randomUUID(),
    delivery = crypto.randomUUID(),
    targets = ['invalid', 'good', 'temporary'].map((address) => ({
      id: crypto.randomUUID(),
      address,
    }));
  await db.query(
    "INSERT INTO notification_outbox(id,school_id,kind,dedupe_key,payload) VALUES($1,$2,'ANNOUNCEMENT','push-target-test','{}')",
    [outbox, f.schoolA],
  );
  await db.query(
    "INSERT INTO notification_deliveries(id,school_id,outbox_id,parent_id,channel,status) VALUES($1,$2,$3,$4,'PUSH','PENDING')",
    [delivery, f.schoolA, outbox, f.parentId],
  );
  for (const target of targets)
    await db.query(
      "INSERT INTO push_tokens(id,school_id,user_id,token_hash,token_encrypted,platform) VALUES($1,$2,$3,$4,$5,'WEB')",
      [target.id, f.schoolA, f.parent, target.id, encrypt(target.address, 'ab'.repeat(32))],
    );
  let transient = true;
  const delivered: string[] = [];
  const send = vi.spyOn(providers, 'deliver').mockImplementation(async (_channel, address) => {
    delivered.push(address);
    if (address === 'invalid')
      throw new providers.DeliveryError('messaging/registration-token-not-registered', true);
    if (address === 'temporary' && transient)
      throw new providers.DeliveryError('TEMPORARY_PROVIDER_FAILURE');
    return 'test-provider-message';
  });
  try {
    await expect(
      sendPushTargets(pools.worker, f.schoolA, delivery, targets, 'Test fixture message'),
    ).rejects.toThrow('TEMPORARY_PROVIDER_FAILURE');
    expect(delivered).toEqual(['invalid', 'good', 'temporary']);
    const tokens = await db.query<{ id: string; is_active: boolean }>(
      'SELECT id,is_active FROM push_tokens WHERE school_id=$1',
      [f.schoolA],
    );
    expect(tokens.rows.find((x) => x.id === targets[0].id)?.is_active).toBe(false);
    expect(tokens.rows.find((x) => x.id === targets[1].id)?.is_active).toBe(true);
    transient = false;
    await sendPushTargets(pools.worker, f.schoolA, delivery, targets, 'Test fixture message');
    expect(delivered).toEqual(['invalid', 'good', 'temporary', 'temporary']);
  } finally {
    send.mockRestore();
    await db.query('DELETE FROM push_delivery_targets WHERE delivery_id=$1', [delivery]);
    await db.query('DELETE FROM push_tokens WHERE id=ANY($1::uuid[])', [targets.map((t) => t.id)]);
    await db.query('DELETE FROM notification_deliveries WHERE id=$1', [delivery]);
    await db.query('DELETE FROM notification_outbox WHERE id=$1', [outbox]);
  }
});
it('shares provider token quotas and keeps the bucket private from browser/API roles', async () => {
  expect(
    (await pools.worker.query("SELECT app.take_provider_token('SMS',1,1) AS wait")).rows[0].wait,
  ).toBe(0);
  expect(
    (await pools.worker.query("SELECT app.take_provider_token('SMS',1,1) AS wait")).rows[0].wait,
  ).toBe(1);
  expect(
    (
      await db.query<{ ok: boolean }>(
        "SELECT has_table_privilege('app_api','provider_buckets','SELECT') AS ok",
      )
    ).rows[0].ok,
  ).toBe(false);
});
it('keeps academic summaries separate by student and exam with weighted percentages', () => {
  const rows = [
    {
      student_code: 'A',
      first_name: 'Learner',
      exam_id: 'one',
      exam: 'Term one',
      score: 40,
      max_score: 50,
    },
    {
      student_code: 'A',
      first_name: 'Learner',
      exam_id: 'one',
      exam: 'Term one',
      score: 90,
      max_score: 100,
    },
    {
      student_code: 'A',
      first_name: 'Learner',
      exam_id: 'two',
      exam: 'Term two',
      score: 25,
      max_score: 50,
    },
    {
      student_code: 'B',
      first_name: 'Other',
      exam_id: 'one',
      exam: 'Term one',
      score: 10,
      max_score: 20,
    },
  ];
  const result = academicSummaries(rows);
  expect(result).toHaveLength(3);
  expect(result[0].score).toBe(130);
  expect(result[0].percentage).toBeCloseTo(86.6667, 3);
  expect(result[1].percentage).toBe(50);
  expect(result[2].subjects).toBe(1);
});
it('keys notification text by locale while keeping child names out of messages', () => {
  const payload = { event_time: '2026-10-18T03:00:00Z', first_name: 'Sensitive child name' };
  expect(messageFor('STUDENT_ARRIVED', payload, 'Asia/Kolkata', 'hi-IN')).toContain(
    'विद्यालय पहुँचा',
  );
  expect(messageFor('STUDENT_ARRIVED', payload, 'Asia/Kolkata', 'en-IN')).toContain('8:30');
  expect(messageFor('STUDENT_ARRIVED', payload, 'Asia/Kolkata', 'hi-IN')).not.toContain(
    'Sensitive child name',
  );
});
it('generates private academic PDFs for the requested exam period and current family scope', async () => {
  const exam = crypto.randomUUID(),
    report = crypto.randomUUID();
  await db.query(
    "INSERT INTO exams(id,school_id,class_id,name,exam_type,starts_on,max_score,status) VALUES($1,$2,$3,'Published term','MIDTERM','2026-06-01',100,'PUBLISHED')",
    [exam, f.schoolA, f.classId],
  );
  await db.query(
    'INSERT INTO marks(school_id,exam_id,student_id,subject_id,score,entered_by) VALUES($1,$2,$3,$4,87,$5)',
    [f.schoolA, exam, f.student, f.subject, f.teacher],
  );
  await db.query(
    "INSERT INTO report_documents(id,school_id,kind,student_id,requested_by,parameters) VALUES($1,$2,'ACADEMIC',$3,$4,$5)",
    [
      report,
      f.schoolA,
      f.student,
      f.parent,
      JSON.stringify({ from: '2026-06-01', to: '2026-06-30' }),
    ],
  );
  let uploaded: Buffer | undefined;
  const storage = {
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, buffer: Buffer) => {
          expect(bucket).toBe('school-documents');
          expect(path.startsWith(`${f.schoolA}/reports/${report}/`)).toBe(true);
          expect(path).toMatch(/\/[0-9a-f-]{36}\.pdf$/);
          uploaded = buffer;
          return { error: null };
        },
      }),
    },
  } as unknown as SupabaseClient;
  await generateReports(pools.worker, f.schoolA, storage);
  const row = (
    await db.query<{ status: string; error_code: string }>(
      'SELECT status,error_code FROM report_documents WHERE id=$1',
      [report],
    )
  ).rows[0];
  expect(row.error_code).toBeNull();
  expect(row.status).toBe('COMPLETED');
  expect(uploaded?.subarray(0, 5).toString()).toBe('%PDF-');
});
it('does no retention work before approval and preserves in-flight work and school records', async () => {
  const report = crypto.randomUUID(),
    completed = crypto.randomUUID(),
    pending = crypto.randomUUID(),
    delivery = crypto.randomUUID(),
    path = `${f.schoolA}/reports/${report}.pdf`;
  await db.query(
    "INSERT INTO report_documents(id,school_id,kind,student_id,requested_by,parameters,status,storage_path,created_at) VALUES($1,$2,'ATTENDANCE',$3,$4,'{}','COMPLETED',$5,'2020-01-01')",
    [report, f.schoolA, f.student, f.parent, path],
  );
  await db.query(
    "INSERT INTO notification_outbox(id,school_id,kind,dedupe_key,payload,status,completed_at) VALUES($1,$2,'ANNOUNCEMENT','retention-completed','{}','COMPLETED','2020-01-01'),($3,$2,'ANNOUNCEMENT','retention-pending','{}','PENDING',NULL)",
    [completed, f.schoolA, pending],
  );
  await db.query(
    "INSERT INTO notification_deliveries(id,school_id,outbox_id,parent_id,channel,status) VALUES($1,$2,$3,$4,'EMAIL','SENT')",
    [delivery, f.schoolA, completed, f.parentId],
  );
  await db.query(
    "INSERT INTO notification_attempts(school_id,delivery_id,attempt,status) VALUES($1,$2,1,'SENT')",
    [f.schoolA, delivery],
  );
  const removed: string[] = [];
  const storage = {
    storage: {
      from: () => ({
        remove: async (paths: string[]) => {
          removed.push(...paths);
          return { error: null };
        },
      }),
    },
  } as unknown as SupabaseClient;
  await applyRetention(pools.worker, f.schoolA, storage);
  expect(removed).toEqual([]);
  await db.query('UPDATE schools SET settings=$2 WHERE id=$1', [
    f.schoolA,
    JSON.stringify({
      retention: {
        policy_ref: 'TEST-APPROVED-POLICY',
        report_days: 180,
        notification_days: 180,
        approved_by: f.admin,
        approved_at: new Date().toISOString(),
      },
    }),
  ]);
  await applyRetention(pools.worker, f.schoolA, storage);
  expect(removed).toEqual([path]);
  expect(
    (
      await db.query<{ status: string }>('SELECT status FROM report_documents WHERE id=$1', [
        report,
      ])
    ).rows[0].status,
  ).toBe('EXPIRED');
  expect(
    (await db.query('SELECT id FROM notification_outbox WHERE id=$1', [completed])).rows,
  ).toEqual([]);
  expect(
    (await db.query('SELECT id FROM notification_outbox WHERE id=$1', [pending])).rows,
  ).toHaveLength(1);
  expect((await db.query('SELECT id FROM students WHERE id=$1', [f.student])).rows).toHaveLength(1);
  await db.query('DELETE FROM notification_outbox WHERE id=$1', [pending]);
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
it('marks absence at school start and defers notifications while readers are offline', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  await db.query(
    "UPDATE schools SET settings=jsonb_set(settings,'{timetable}',$2::jsonb) WHERE id=$1",
    [
      f.schoolA,
      {
        ...defaultSchoolTimings,
        start_time: '09:00',
        version: 1,
        lecture_count: 1,
        periods: [{ number: 1, label: 'Lecture 1', start_time: '09:00', end_time: '09:40' }],
      },
    ],
  );
  const run = async (utc: string) => {
    vi.setSystemTime(new Date(utc));
    await scheduledJobs(pools.worker, f.schoolA);
  };
  const status = async (date: string) =>
    (
      await db.query(
        'SELECT attendance_status,provisional,version FROM daily_attendance WHERE school_id=$1 AND student_id=$2 AND attendance_date=$3',
        [f.schoolA, f.student, date],
      )
    ).rows[0];
  const absenceAlerts = async () =>
    (
      await db.query(
        "SELECT id FROM notification_outbox WHERE school_id=$1 AND kind='STUDENT_ABSENT'",
        [f.schoolA],
      )
    ).rows;
  try {
    await run('2026-10-17T03:29:59Z');
    expect(await status('2026-10-17')).toMatchObject({ attendance_status: 'PENDING' });
    await run('2026-10-17T03:30:00Z');
    const absent = await status('2026-10-17');
    expect(absent).toMatchObject({ attendance_status: 'ABSENT', provisional: true });
    await run('2026-10-17T07:15:00Z');
    expect(await status('2026-10-17')).toEqual(absent);
    expect(await absenceAlerts()).toHaveLength(0);
    await run('2026-10-17T10:01:00Z');
    await run('2026-10-17T10:02:00Z');
    expect(await status('2026-10-17')).toEqual(absent);
    expect(await absenceAlerts()).toHaveLength(1);

    await run('2026-10-19T03:30:00Z');
    vi.setSystemTime(new Date('2026-10-19T03:40:00Z'));
    await processEvent(
      pools.device,
      { id: f.deviceA, schoolId: f.schoolA, code: 'DEV_A', status: 'ACTIVE' },
      {
        event_id: crypto.randomUUID(),
        device_id: 'DEV_A',
        card_uid: 'AABBCCDD',
        event_timestamp: new Date().toISOString(),
        time_source: 'RTC_SYNCED',
        sequence_number: 1,
        boot_id: crypto.randomUUID(),
        firmware_version: 'test',
      },
      'worker-absence-test',
    );
    expect(await status('2026-10-19')).toMatchObject({
      attendance_status: 'LATE',
      provisional: false,
    });
    await run('2026-10-19T10:01:00Z');
    expect(await absenceAlerts()).toHaveLength(1);

    await db.query(
      "INSERT INTO school_holidays(school_id,kind,on_date,label) VALUES($1,'HOLIDAY','2026-10-20','School holiday')",
      [f.schoolA],
    );
    await run('2026-10-20T03:30:00Z');
    expect(await status('2026-10-20')).toBeUndefined();

    await run('2026-10-21T03:30:00Z');
    const beforeManual = await status('2026-10-21');
    expect(beforeManual).toMatchObject({ attendance_status: 'ABSENT' });
    const context = { schoolId: f.schoolA, userId: f.teacher };
    await transaction(pools.api, context, (tx) =>
      markManualAttendance(tx, { context, id: f.teacher, active: { role: 'teacher' } } as Actor, {
        student_id: f.student,
        date: '2026-10-21',
        status: 'HALF_DAY',
        reason: 'Verified classroom attendance',
        expected_version: beforeManual.version,
      }),
    );
    await run('2026-10-21T10:01:00Z');
    expect(await status('2026-10-21')).toMatchObject({
      attendance_status: 'HALF_DAY',
      provisional: false,
    });
    expect(await absenceAlerts()).toHaveLength(1);

    await run('2026-10-22T03:30:00Z');
    await db.query("UPDATE devices SET last_seen_at='2026-10-22T06:59:30Z' WHERE school_id=$1", [
      f.schoolA,
    ]);
    await run('2026-10-22T07:00:00Z');
    expect(await status('2026-10-22')).toMatchObject({
      attendance_status: 'ABSENT',
      provisional: false,
    });
    expect(await absenceAlerts()).toHaveLength(2);
  } finally {
    vi.useRealTimers();
  }
});
