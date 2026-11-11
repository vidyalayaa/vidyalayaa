import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { transaction } from '../../api/src/lib/db.js';

export async function purgeApprovedSchool(
  pool: pg.Pool,
  schoolId: string,
  storage: SupabaseClient,
) {
  const ctx = { schoolId, actorType: 'SYSTEM' as const };
  const lease = randomUUID();
  const job = await transaction(
    pool,
    ctx,
    async (tx) =>
      (
        await tx.query(
          `UPDATE school_offboarding SET status='PURGING',last_error=NULL,purge_lease=$2
           WHERE school_id=$1 AND NOT legal_hold AND delete_after<=now() AND export_until<=now()
           AND ((status='PURGE_REQUESTED' AND (NOT permanent OR last_error IS NULL OR updated_at<now()-interval '1 minute'))
             OR (status='PURGING' AND updated_at<now()-interval '30 minutes')) RETURNING *`,
          [schoolId, lease],
        )
      ).rows[0],
  );
  if (!job) return;
  try {
    const ready = await transaction(
      pool,
      ctx,
      async (tx) => {
        if (
          !job.school_approved_by ||
          !job.closed_by ||
          job.school_approved_by === job.closed_by ||
          !job.purge_requested_by ||
          (job.permanent &&
            (!job.approved_at ||
              job.approval_recipient !== job.school_approved_by ||
              !job.purge_requested_at))
        )
          throw new Error('PURGE_APPROVAL_INVALID');
        if (
          (
            await tx.query(
              "SELECT id FROM school_exports WHERE school_id=$1 AND status IN ('PENDING','PROCESSING') UNION ALL SELECT id FROM report_documents WHERE school_id=$1 AND status IN ('PENDING','PROCESSING') LIMIT 1",
              [schoolId],
            )
          ).rowCount
        )
          throw new Error('EXPORT_JOBS_STILL_RUNNING');
        return !!(
          await tx.query(
            "SELECT id FROM school_exports WHERE school_id=$1 AND status='COMPLETED' AND completed_at>=$2 AND (NOT $3::boolean OR snapshot_at>=$2) LIMIT 1",
            [schoolId, job.closed_at, job.permanent],
          )
        ).rowCount;
      },
      true,
    );
    if (!ready) throw new Error('FINAL_EXPORT_REQUIRED');
    if (job.permanent)
      await transaction(
        pool,
        ctx,
        async (tx) => {
          await tx.query('SELECT app.school_erasure_relations()');
          const school = await tx.query(
            `SELECT id FROM schools WHERE id=$1 AND status='SUSPENDED'
           AND NOT EXISTS(SELECT FROM devices WHERE school_id=$1 AND status<>'REVOKED')`,
            [schoolId],
          );
          if (!school.rowCount) throw new Error('SCHOOL_NOT_CLOSED');
        },
        true,
      );
    const bucket = storage.storage.from('school-documents');
    const collect = async (prefix: string, depth = 0): Promise<string[]> => {
      if (depth > 12 || (prefix !== schoolId && !prefix.startsWith(schoolId + '/')))
        throw new Error('INVALID_PURGE_PREFIX');
      const files: string[] = [];
      for (let offset = 0; ; offset += 100) {
        const result = await bucket.list(prefix, {
          limit: 100,
          offset,
          sortBy: { column: 'name', order: 'asc' },
        });
        if (result.error) throw new Error('STORAGE_LIST_FAILED');
        for (const entry of result.data) {
          if (!entry.name || /[/\\\\]/.test(entry.name) || ['.', '..'].includes(entry.name))
            throw new Error('INVALID_STORAGE_ENTRY');
          const path = prefix + '/' + entry.name;
          if (entry.id) files.push(path);
          else files.push(...(await collect(path, depth + 1)));
        }
        if (result.data.length < 100) break;
      }
      return files;
    };
    const files = await collect(schoolId);
    if (job.permanent) {
      // Commit the irreversible marker before any external delete. A hold can
      // still stop this transition while discovery and export checks run.
      await transaction(pool, ctx, async (tx) => {
        const started = await tx.query(
          `UPDATE school_offboarding SET irreversible_at=coalesce(irreversible_at,clock_timestamp())
           WHERE id=$1 AND school_id=$2 AND purge_lease=$3 AND status='PURGING' AND NOT legal_hold
           RETURNING id`,
          [job.id, schoolId, lease],
        );
        if (!started.rowCount) throw new Error('PURGE_PAUSED');
      });
    }
    for (let i = 0; i < files.length; i += 100)
      await transaction(pool, ctx, async (tx) => {
        const current = (
          await tx.query(
            "SELECT id FROM school_offboarding WHERE id=$1 AND purge_lease=$2 AND NOT legal_hold AND status='PURGING' FOR UPDATE",
            [job.id, lease],
          )
        ).rows[0];
        if (!current) throw new Error('PURGE_PAUSED');
        const result = await bucket.remove(files.slice(i, i + 100));
        if (result.error) throw new Error('STORAGE_PURGE_FAILED');
        await tx.query('UPDATE school_offboarding SET updated_at=now() WHERE id=$1', [job.id]);
        await tx.query(
          "INSERT INTO audit_logs(school_id,actor_type,action,entity_type,entity_id,after) VALUES($1,'SYSTEM','school.storage_purge_batch','school_offboarding',$2,$3)",
          [schoolId, job.id, { removed: Math.min(100, files.length - i) }],
        );
      });
    if ((await collect(schoolId)).length) throw new Error('STORAGE_PURGE_INCOMPLETE');
    await transaction(pool, ctx, async (tx) => {
      const updated = await tx.query(
        "UPDATE school_offboarding SET storage_purged_at=now() WHERE id=$1 AND purge_lease=$2 AND NOT legal_hold AND status='PURGING' RETURNING id",
        [job.id, lease],
      );
      if (!updated.rowCount) throw new Error('PURGE_PAUSED');
      if (job.permanent) await tx.query('SELECT app.erase_school($1,$2)', [job.id, lease]);
      else await tx.query('SELECT app.purge_approved_school($1)', [job.id]);
    });
  } catch (error) {
    await transaction(pool, ctx, (tx) =>
      tx.query(
        "UPDATE school_offboarding SET status='PURGE_REQUESTED',last_error=$2,purge_lease=NULL WHERE id=$1 AND purge_lease=$3",
        [
          job.id,
          error instanceof Error && /^[A-Z_]+$/.test(error.message)
            ? error.message
            : 'PURGE_FAILED',
          lease,
        ],
      ),
    );
  }
}
