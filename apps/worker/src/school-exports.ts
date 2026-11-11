import type pg from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { captureFailure } from '../../api/src/lib/monitoring.js';
import { transaction } from '../../api/src/lib/db.js';
import { personPhotoPath } from '../../api/src/lib/person-photo-path.js';

const tables = [
  'school_profile_assets',
  'school_person_details',
  'support_requests',
  'school_memberships',
  'academic_sessions',
  'academic_promotions',
  'classes',
  'subjects',
  'students',
  'parents',
  'teachers',
  'student_parents',
  'enrollments',
  'teacher_class_assignments',
  'exams',
  'marks',
  'assignments',
  'timetable_entries',
  'school_holidays',
  'announcements',
  'fee_records',
  'fee_structures',
  'fee_structure_sections',
  'fee_structure_items',
  'fee_transport_routes',
  'fee_transport_assignments',
  'fee_payments',
  'fee_payment_allocations',
  'fee_payment_reversals',
  'nfc_cards',
  'device_locations',
  'devices',
  'device_configurations',
  'device_heartbeats',
  'device_logs',
  'device_ota_status',
  'device_ota_assignments',
  'attendance_rule_versions',
  'attendance_events',
  'daily_attendance',
  'attendance_corrections',
  'attendance_reconciliation_requests',
  'notification_preferences',
  'school_notification_settings',
  'notification_recipient_targets',
  'notification_outbox',
  'notification_deliveries',
  'notification_attempts',
  'report_documents',
  'school_invitations',
  'audit_logs',
] as const;
const json = (value: unknown) =>
  JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v));
const secretFields = new Set(['secret_hash', 'claim_code_hash', 'token_encrypted', 'token_hash']);
export interface ExportFile {
  name: string;
  path: string;
  sha256: string;
  bytes: number;
  rows?: number;
}
function csvCell(value: unknown) {
  const text =
    value === null || value === undefined
      ? ''
      : typeof value === 'object'
        ? json(value)
        : String(value);
  return '"' + (/^[\s\uFEFF]*[=+@-]/.test(text) ? "'" + text : text).replaceAll('"', '""') + '"';
}
export async function generateSchoolExport(
  pool: pg.Pool,
  schoolId: string,
  storage: SupabaseClient,
) {
  const ctx = { schoolId, actorType: 'SYSTEM' as const },
    lease = randomUUID();
  const job = await transaction(
    pool,
    ctx,
    async (tx) =>
      (
        await tx.query(
          "WITH picked AS(SELECT id FROM school_exports WHERE school_id=$1 AND (status='PENDING' OR (status='PROCESSING' AND locked_until<now())) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE school_exports e SET status='PROCESSING',lease_token=$2,locked_until=now()+interval '20 minutes',error_code=NULL FROM picked WHERE e.id=picked.id RETURNING e.*",
          [schoolId, lease],
        )
      ).rows[0],
  );
  if (!job) return;
  const local = await mkdtemp(join(tmpdir(), 'vidyalayaa-export-'));
  if (
    dirname(resolve(local)) !== resolve(tmpdir()) ||
    !basename(local).startsWith('vidyalayaa-export-')
  )
    throw new Error('EXPORT_TEMP_PATH_INVALID');
  const staged: { name: string; type: string; rows?: number }[] = [],
    objects = new Set<string>(),
    started = Date.now();
  const stage = async (name: string, buffer: Buffer, type: string, rows?: number) => {
    await writeFile(join(local, name), buffer);
    staged.push({ name, type, rows });
  };
  const manifest: ExportFile[] = [],
    prefix = `${schoolId}/exports/${job.id}/${lease}`;
  try {
    const upload = async (name: string, buffer: Buffer, type: string, rows?: number) => {
      const own = await transaction(pool, ctx, (tx) =>
        tx.query(
          "UPDATE school_exports SET locked_until=now()+interval '5 minutes' WHERE id=$1 AND lease_token=$2 AND status='PROCESSING' RETURNING id",
          [job.id, lease],
        ),
      );
      if (!own.rowCount) throw new Error('EXPORT_LEASE_LOST');
      const path = `${prefix}/${name}`,
        result = await storage.storage
          .from('school-documents')
          .upload(path, buffer, { contentType: type, upsert: false });
      if (result.error) throw new Error('EXPORT_STORAGE_UNAVAILABLE');
      manifest.push({
        name,
        path,
        sha256: createHash('sha256').update(buffer).digest('hex'),
        bytes: buffer.length,
        ...(rows === undefined ? {} : { rows }),
      });
    };
    const snapshot = await transaction(
      pool,
      ctx,
      async (tx) => {
        const member = await tx.query(
          "SELECT m.id FROM school_memberships m JOIN roles r ON r.id=m.role_id JOIN users u ON u.id=m.user_id WHERE m.school_id=$1 AND m.user_id=$2 AND m.status='ACTIVE' AND u.status='ACTIVE' AND r.code='school_admin'",
          [schoolId, job.requested_by],
        );
        if (!member.rowCount) throw new Error('EXPORT_PERMISSION_REVOKED');
        const snapshot = (await tx.query('SELECT transaction_timestamp() AS ts')).rows[0].ts;
        const school = (
          await tx.query(
            'SELECT school_code,name,timezone,status,settings,profile,profile_version FROM schools WHERE id=$1',
            [schoolId],
          )
        ).rows[0];
        await stage(
          'school.json',
          Buffer.from(json({ snapshot_at: snapshot, school })),
          'application/json',
        );
        const administration = (
          await tx.query(
            'SELECT school_id,details,principal_edit_authorized,updated_at FROM school_profile_private WHERE school_id=$1',
            [schoolId],
          )
        ).rows;
        await stage(
          'school-profile-private.json',
          Buffer.from(json(administration)),
          'application/json',
          administration.length,
        );
        const users = (await tx.query('SELECT * FROM app.export_school_users()')).rows;
        await stage('users.json', Buffer.from(json(users)), 'application/json', users.length);

        for (const table of tables) {
          let cursor: string | null = null,
            part = 0;
          for (;;) {
            const idType = table === 'audit_logs' ? 'bigint' : 'uuid';
            const feeDateColumns: Record<string, string[]> = {
              fee_records: ['due_on'],
              fee_structure_items: ['first_due_on'],
              fee_transport_assignments: ['starts_on', 'ends_on', 'first_due_on', 'ended_on'],
              fee_payments: ['payment_date'],
            };
            const feeDates = (feeDateColumns[table] || [])
              .map((column) => `,t.${column}::text AS ${column}`)
              .join('');
            if (Date.now() - started > 900000) throw new Error('EXPORT_SNAPSHOT_DEADLINE');
            const page: Record<string, any>[] = (
              table === 'school_person_details'
                ? await tx.query(
                    'SELECT * FROM app.export_school_person_details($1,$2,$3) ORDER BY id',
                    [job.id, lease, cursor],
                  )
                : await tx.query(
                    `SELECT t.*${feeDates} FROM ${table} t WHERE t.school_id=$1 AND ($2::${idType} IS NULL OR t.id>$2::${idType}) ORDER BY t.id LIMIT 500`,
                    [schoolId, cursor],
                  )
            ).rows;
            if (!page.length) break;
            cursor = String(page.at(-1)!.id);
            part++;
            const records = page.map((row) =>
              Object.fromEntries(Object.entries(row).filter(([key]) => !secretFields.has(key))),
            );
            for (const row of records) {
              if (
                typeof row.storage_path === 'string' &&
                row.storage_path.startsWith(`${schoolId}/`) &&
                !row.storage_path.startsWith(`${schoolId}/exports/`)
              )
                objects.add(row.storage_path);
              if (
                (table === 'students' || table === 'teachers') &&
                typeof row.profile_photo_id === 'string'
              )
                objects.add(
                  personPhotoPath(
                    schoolId,
                    table === 'students' ? 'student' : 'staff',
                    String(row.id),
                    row.profile_photo_id,
                  ),
                );
            }
            const header = Object.keys(records[0]);
            const content =
              job.format === 'CSV'
                ? [
                    header.map(csvCell).join(','),
                    ...records.map((row) => header.map((h) => csvCell(row[h])).join(',')),
                  ].join('\r\n')
                : json(records);
            await stage(
              `${table}-${String(part).padStart(5, '0')}.${job.format === 'CSV' ? 'csv' : 'json'}`,
              Buffer.from(content),
              job.format === 'CSV' ? 'text/csv' : 'application/json',
              records.length,
            );
          }
        }
        return snapshot;
      },
      true,
      'repeatable read',
    );
    for (const file of staged)
      await upload(file.name, await readFile(join(local, file.name)), file.type, file.rows);
    let index = 0;
    for (const path of objects) {
      const object = await storage.storage.from('school-documents').download(path);
      if (object.error) throw new Error('EXPORT_SOURCE_OBJECT_MISSING');
      const filename = path
        .split('/')
        .at(-1)!
        .replace(/[^a-zA-Z0-9._-]/g, '_');
      await upload(
        `objects-${String(++index).padStart(5, '0')}-${filename}`,
        Buffer.from(await object.data.arrayBuffer()),
        object.data.type || 'application/octet-stream',
      );
    }

    await transaction(pool, ctx, async (tx) => {
      const completed = await tx.query(
        "UPDATE school_exports SET status='COMPLETED',manifest=$3,snapshot_at=$4,completed_at=now(),locked_until=NULL WHERE id=$1 AND lease_token=$2 RETURNING id",
        [job.id, lease, JSON.stringify(manifest), snapshot],
      );
      if (!completed.rowCount) throw new Error('EXPORT_LEASE_LOST');
      await tx.query(
        "INSERT INTO audit_logs(school_id,actor_type,action,entity_type,entity_id,after) VALUES($1,'SYSTEM','school.export_completed','school_exports',$2,$3)",
        [
          schoolId,
          job.id,
          { files: manifest.length, total_bytes: manifest.reduce((n, f) => n + f.bytes, 0) },
        ],
      );
    });
  } catch (error) {
    const current = await transaction(
      pool,
      ctx,
      async (tx) =>
        (await tx.query('SELECT status FROM school_exports WHERE id=$1', [job.id])).rows[0],
      true,
    );
    if (current?.status === 'COMPLETED') return;
    captureFailure(error, 'SCHOOL_EXPORT_FAILED');
    // Failed attempts are never published as a successful/complete export.
    for (let i = 0; i < manifest.length; i += 100)
      await storage.storage
        .from('school-documents')
        .remove(manifest.slice(i, i + 100).map((f) => f.path))
        .catch(() => {});
    await transaction(pool, ctx, (tx) =>
      tx.query(
        "UPDATE school_exports SET status='FAILED',error_code=$3,locked_until=NULL WHERE id=$1 AND lease_token=$2 AND status='PROCESSING'",
        [
          job.id,
          lease,
          error instanceof Error && /^[A-Z_]+$/.test(error.message)
            ? error.message
            : 'EXPORT_FAILED',
        ],
      ),
    );
  } finally {
    await rm(local, { recursive: true, force: true });
  }
}
