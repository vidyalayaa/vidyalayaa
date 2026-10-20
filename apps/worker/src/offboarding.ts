import type pg from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';
import { transaction } from '../../api/src/lib/db.js';

export async function purgeApprovedSchool(
  pool: pg.Pool,
  schoolId: string,
  storage: SupabaseClient,
) {
  const ctx = { schoolId, actorType: 'SYSTEM' as const };
  const job = await transaction(
    pool,
    ctx,
    async (tx) =>
      (
        await tx.query(
          "UPDATE school_offboarding SET status='PURGING',last_error=NULL WHERE school_id=$1 AND legal_hold=false AND delete_after<=now() AND export_until<=now() AND (status='PURGE_REQUESTED' OR (status='PURGING' AND updated_at<now()-interval '30 minutes')) RETURNING *",
          [schoolId],
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
          !job.purge_requested_by
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
            "SELECT id FROM school_exports WHERE school_id=$1 AND status='COMPLETED' AND completed_at>=$2 LIMIT 1",
            [schoolId, job.closed_at],
          )
        ).rowCount;
      },
      true,
    );
    if (!ready) throw new Error('FINAL_EXPORT_REQUIRED');
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
          if (!entry.name || entry.name.includes('/') || entry.name === '..')
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
    for (let i = 0; i < files.length; i += 100)
      await transaction(pool, ctx, async (tx) => {
        const current = (
          await tx.query('SELECT legal_hold,status FROM school_offboarding WHERE id=$1 FOR SHARE', [
            job.id,
          ])
        ).rows[0];
        if (current.legal_hold || current.status !== 'PURGING') throw new Error('PURGE_PAUSED');
        const result = await bucket.remove(files.slice(i, i + 100));
        if (result.error) throw new Error('STORAGE_PURGE_FAILED');
        await tx.query(
          "INSERT INTO audit_logs(school_id,actor_type,action,entity_type,entity_id,after) VALUES($1,'SYSTEM','school.storage_purge_batch','school_offboarding',$2,$3)",
          [schoolId, job.id, { removed: Math.min(100, files.length - i) }],
        );
      });
    if ((await collect(schoolId)).length) throw new Error('STORAGE_PURGE_INCOMPLETE');
    await transaction(pool, ctx, async (tx) => {
      await tx.query('UPDATE school_offboarding SET storage_purged_at=now() WHERE id=$1', [job.id]);
      await tx.query('SELECT app.purge_approved_school($1)', [job.id]);
    });
  } catch (error) {
    await transaction(pool, ctx, (tx) =>
      tx.query("UPDATE school_offboarding SET status='PURGE_REQUESTED',last_error=$2 WHERE id=$1", [
        job.id,
        error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'PURGE_FAILED',
      ]),
    );
  }
}
