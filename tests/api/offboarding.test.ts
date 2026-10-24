import { beforeAll, afterAll, it, expect } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { portableDatabase, poolAdapters, fixture } from '../helpers/database.js';
import { transaction, platformTx } from '../../apps/api/src/lib/db.js';
import { purgeApprovedSchool } from '../../apps/worker/src/offboarding.js';
let db: PGlite,
  pools: ReturnType<typeof poolAdapters>,
  f: Awaited<ReturnType<typeof fixture>>,
  platformUser: string,
  job: string;
beforeAll(async () => {
  db = await portableDatabase();
  pools = poolAdapters(db);
  f = await fixture(db);
  platformUser = crypto.randomUUID();
  await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [
    platformUser,
    'platform@example.invalid',
  ]);
  await db.query("INSERT INTO platform_staff(user_id,platform_role) VALUES($1,'SUPER_ADMIN')", [
    platformUser,
  ]);
  await db.query(
    "INSERT INTO school_invitations(school_id,email,full_name,role_code,invited_by,status,parent_id) VALUES($1,'historic-parent@example.invalid','Historic linked parent','parent',$2,'REVOKED',$3)",
    [f.schoolA, f.admin, f.parentId],
  );
  await db.query(
    'INSERT INTO school_notification_settings(school_id,updated_by) VALUES($1,$3),($2,$3)',
    [f.schoolA, f.schoolB, f.admin],
  );
  const custom = crypto.randomUUID();
  await db.query(
    "INSERT INTO notification_outbox(id,school_id,kind,dedupe_key,payload,status) VALUES($1,$2,'CUSTOM','purge-custom-fixture','{}','COMPLETED')",
    [custom, f.schoolA],
  );
  await db.query(
    'INSERT INTO notification_recipient_targets(school_id,outbox_id,user_id) VALUES($1,$2,$3)',
    [f.schoolA, custom, f.parent],
  );
  job = (
    await db.query<{ id: string }>(
      "INSERT INTO school_offboarding(school_id,requested_by,policy_ref,reason,export_until,delete_after) VALUES($1,$2,'TEST-CONTRACT','Isolated test offboarding',now()+interval '1 day',now()+interval '2 days') RETURNING id",
      [f.schoolA, platformUser],
    )
  ).rows[0].id;
});
afterAll(async () => db.close());
it('requires distinct school approval and drained devices before closure', async () => {
  await expect(
    platformTx(pools.platform, platformUser, (tx) =>
      tx.query('SELECT app.close_approved_school($1)', [job]),
    ),
  ).rejects.toThrow('OFFBOARDING_APPROVAL_REQUIRED');
  await db.query(
    "UPDATE school_offboarding SET status='APPROVED',school_approved_by=$2 WHERE id=$1",
    [job, f.admin],
  );
  await expect(
    platformTx(pools.platform, platformUser, (tx) =>
      tx.query('SELECT app.close_approved_school($1)', [job]),
    ),
  ).rejects.toThrow('DEVICE_SYNC_REQUIRED');
  await db.query('UPDATE devices SET last_seen_at=now(),pending_event_count=0 WHERE school_id=$1', [
    f.schoolA,
  ]);
  await platformTx(pools.platform, platformUser, (tx) =>
    tx.query('SELECT app.close_approved_school($1)', [job]),
  );
  expect(
    (
      await db.query<{ status: string }>('SELECT status FROM devices WHERE school_id=$1', [
        f.schoolA,
      ])
    ).rows.every((r) => r.status === 'REVOKED'),
  ).toBe(true);
  await expect(
    transaction(pools.api, { schoolId: f.schoolA, userId: f.admin }, (tx) =>
      tx.query('SELECT app.purge_approved_school($1)', [job]),
    ),
  ).rejects.toThrow('permission denied');
});
it('fails closed on legal hold, missing final export and failed storage removal', async () => {
  const objects = new Map([
    [f.schoolA + '/one.pdf', Buffer.from('private fixture')],
    [f.schoolB + '/foreign.pdf', Buffer.from('foreign fixture')],
  ]);
  let fail = true;
  const bucket = {
    list: async (prefix: string) => ({
      data: [...objects.keys()]
        .filter((p) => p.startsWith(prefix + '/'))
        .map((p) => ({ id: p, name: p.slice(prefix.length + 1) })),
      error: null,
    }),
    remove: async (paths: string[]) => {
      if (fail) return { error: { message: 'unavailable' } };
      paths.forEach((p) => objects.delete(p));
      return { error: null };
    },
  };
  const storage = { storage: { from: () => bucket } } as unknown as SupabaseClient;
  await db.query(
    "UPDATE school_offboarding SET status='PURGE_REQUESTED',purge_requested_by=$2,export_until=now()-interval '2 days',delete_after=now()-interval '1 day' WHERE id=$1",
    [job, platformUser],
  );
  await purgeApprovedSchool(pools.worker, f.schoolA, storage);
  expect(objects.has(f.schoolA + '/one.pdf')).toBe(true);
  await db.query('UPDATE school_offboarding SET legal_hold=false WHERE id=$1', [job]);
  await purgeApprovedSchool(pools.worker, f.schoolA, storage);
  expect(
    (
      await db.query<{ last_error: string }>(
        'SELECT last_error FROM school_offboarding WHERE id=$1',
        [job],
      )
    ).rows[0].last_error,
  ).toBe('FINAL_EXPORT_REQUIRED');
  await db.query(
    "INSERT INTO school_exports(school_id,requested_by,format,status,completed_at) VALUES($1,$2,'JSON','COMPLETED',now()+interval '1 second')",
    [f.schoolA, f.admin],
  );
  await purgeApprovedSchool(pools.worker, f.schoolA, storage);
  expect(
    (
      await db.query<{ last_error: string }>(
        'SELECT last_error FROM school_offboarding WHERE id=$1',
        [job],
      )
    ).rows[0].last_error,
  ).toBe('STORAGE_PURGE_FAILED');
  expect(
    (await db.query('SELECT id FROM students WHERE school_id=$1', [f.schoolA])).rows,
  ).toHaveLength(1);
  fail = false;
  await purgeApprovedSchool(pools.worker, f.schoolA, storage);
  const result = (
    await db.query<{ status: string; last_error: string | null }>(
      'SELECT status,last_error FROM school_offboarding WHERE id=$1',
      [job],
    )
  ).rows[0];
  expect(result).toEqual({ status: 'PURGED', last_error: null });
  expect(
    (await db.query('SELECT id FROM school_notification_settings WHERE school_id=$1', [f.schoolA]))
      .rows,
  ).toHaveLength(0);
  expect(
    (await db.query('SELECT id FROM school_notification_settings WHERE school_id=$1', [f.schoolB]))
      .rows,
  ).toHaveLength(1);
  expect(
    (
      await db.query('SELECT id FROM notification_recipient_targets WHERE school_id=$1', [
        f.schoolA,
      ])
    ).rows,
  ).toHaveLength(0);
  expect(objects.has(f.schoolB + '/foreign.pdf')).toBe(true);
  expect(
    (await db.query('SELECT id FROM students WHERE school_id=$1', [f.schoolA])).rows,
  ).toHaveLength(0);
  expect(
    (await db.query('SELECT id FROM students WHERE school_id=$1', [f.schoolB])).rows,
  ).toHaveLength(1);
  expect(
    (
      await db.query(
        "SELECT id FROM audit_logs WHERE school_id=$1 AND action='school.operational_data_purged'",
        [f.schoolA],
      )
    ).rows,
  ).toHaveLength(1);
});
