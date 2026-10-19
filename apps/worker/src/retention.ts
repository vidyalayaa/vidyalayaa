import type pg from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';
import { transaction } from '../../api/src/lib/db.js';
export async function applyRetention(pool: pg.Pool, schoolId: string, storage: SupabaseClient) {
  const ctx = { schoolId, actorType: 'SYSTEM' as const };
  const policy = await transaction(
    pool,
    ctx,
    async (tx) => {
      const school = (await tx.query('SELECT settings FROM schools WHERE id=$1', [schoolId]))
        .rows[0];
      const p = school?.settings.retention;
      if (!p?.approved_at || !p.policy_ref) return null;
      if (!Number.isInteger(p.report_days) || p.report_days < 7 || p.report_days > 3650)
        throw new Error('RETENTION_POLICY_INVALID');
      const plan = (
        await tx.query(
          'SELECT p.limits,s.limit_overrides FROM subscriptions s JOIN subscription_plans p ON p.id=s.plan_id WHERE school_id=$1 ORDER BY s.created_at DESC LIMIT 1',
          [schoolId],
        )
      ).rows[0];
      const limit = Number(
        plan?.limit_overrides?.report_retention_days ?? plan?.limits.report_retention_days ?? 180,
      );
      return { ...p, report_days: Math.min(p.report_days, Math.max(7, limit)) };
    },
    true,
  );
  if (!policy) return;
  const rows = await transaction(
    pool,
    ctx,
    (tx) =>
      tx.query(
        "SELECT id,storage_path FROM report_documents WHERE school_id=$1 AND status='COMPLETED' AND storage_path IS NOT NULL AND created_at<now()-make_interval(days=>$2) ORDER BY created_at LIMIT 100",
        [schoolId, policy.report_days],
      ),
    true,
  );
  for (const row of rows.rows) {
    const path = `${schoolId}/reports/${row.id}.pdf`;
    if (row.storage_path !== path) throw new Error('RETENTION_PATH_INVALID');
    const result = await storage.storage.from('school-documents').remove([path]);
    if (result.error) throw new Error('RETENTION_STORAGE_FAILED');
    await transaction(pool, ctx, async (tx) => {
      await tx.query(
        "UPDATE report_documents SET status='EXPIRED',storage_path=NULL,error_code='REPORT_RETENTION_EXPIRED' WHERE school_id=$1 AND id=$2 AND storage_path=$3",
        [schoolId, row.id, path],
      );
      await tx.query(
        "INSERT INTO audit_logs(school_id,actor_type,action,entity_type,entity_id,after) VALUES($1,'SYSTEM','retention.report','report_documents',$2,$3)",
        [schoolId, row.id, JSON.stringify({ policy_ref: policy.policy_ref })],
      );
    });
  }
  await transaction(pool, ctx, (tx) => tx.query('SELECT app.prune_terminal_notifications()'));
}
