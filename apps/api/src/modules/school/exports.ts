import { Router } from 'express';
import type pg from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { uuid, exportRequestSchema } from '@vidyalayaa/contracts';
import { permission } from '../../middleware/auth.js';
import { asyncRoute, ApiError, notFound } from '../../lib/errors.js';
import { transaction, audit } from '../../lib/db.js';
import { paged } from '../../lib/pagination.js';
import { signedDownload, verifyDownload } from '../../lib/downloads.js';

export function exportsRouter(pool: pg.Pool, storage: SupabaseClient, key: string) {
  const r = Router();
  r.use(['/exports', '/offboarding'], permission('school.manage'));
  r.get(
    '/offboarding',
    asyncRoute(async (_req, res) => {
      const a = res.locals.actor;
      res.json(
        await transaction(
          pool,
          a.context,
          async (tx) => ({
            data: (
              await tx.query(
                'SELECT id,policy_ref,reason,export_until,delete_after,legal_hold,status,school_approved_by,closed_at,permanent FROM school_offboarding WHERE school_id=$1 AND (NOT permanent OR $2) ORDER BY created_at DESC LIMIT 10',
                [a.context.schoolId, a.active?.role === 'school_admin'],
              )
            ).rows,
          }),
          true,
        ),
      );
    }),
  );
  r.post(
    '/offboarding/:id/approve',
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        id = uuid.parse(req.params.id),
        b = z
          .object({ approve: z.boolean(), policy_ref: z.string().min(5).max(200) })
          .strict()
          .parse(req.body);
      await transaction(pool, a.context, async (tx) => {
        const row = await tx.query(
          "UPDATE school_offboarding SET status=$3,school_approved_by=CASE WHEN $3='APPROVED' THEN $4::uuid ELSE NULL END WHERE school_id=$1 AND id=$2 AND NOT permanent AND status IN ('REQUESTED','APPROVED') AND policy_ref=$5 RETURNING id",
          [a.context.schoolId, id, b.approve ? 'APPROVED' : 'CANCELLED', a.id, b.policy_ref],
        );
        if (!row.rowCount) throw notFound();
        await audit(
          tx,
          a.context.schoolId,
          a.id,
          'offboarding.school_decision',
          'school_offboarding',
          id,
        );
      });
      res.status(204).end();
    }),
  );
  r.post(
    '/exports',
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        b = exportRequestSchema.parse(req.body);
      const row = await transaction(pool, a.context, async (tx) => {
        await tx.query('SELECT id FROM schools WHERE id=$1 FOR UPDATE', [a.context.schoolId]);
        const closed = await tx.query(
          `SELECT id FROM school_offboarding WHERE school_id=$1
           AND status IN ('CLOSED','PURGE_REQUESTED','PURGING','PURGED')
           AND (irreversible_at IS NOT NULL OR export_until<=clock_timestamp())`,
          [a.context.schoolId],
        );
        if (closed.rowCount)
          throw new ApiError(403, 'SCHOOL_OFFBOARDED', 'The school export window has ended.');
        const pending = Number(
          (
            await tx.query(
              "SELECT count(*) FROM school_exports WHERE school_id=$1 AND status IN ('PENDING','PROCESSING')",
              [a.context.schoolId],
            )
          ).rows[0].count,
        );
        if (pending >= 2)
          throw new ApiError(409, 'EXPORT_PENDING', 'Wait for the existing export to finish.');
        const row = (
          await tx.query(
            'INSERT INTO school_exports(school_id,requested_by,format) VALUES($1,$2,$3) RETURNING id,status',
            [a.context.schoolId, a.id, b.format],
          )
        ).rows[0];
        await tx.query(
          "INSERT INTO audit_logs(school_id,actor_type,actor_id,action,entity_type,entity_id,after) VALUES($1,'USER',$2,'school.export_requested','school_exports',$3,$4)",
          [a.context.schoolId, a.id, row.id, { reason: b.reason, format: b.format }],
        );
        return row;
      });
      res.status(202).json(row);
    }),
  );
  r.get(
    '/exports',
    asyncRoute(async (req, res) => {
      const a = res.locals.actor;
      res.json(
        await transaction(
          pool,
          a.context,
          (tx) =>
            paged(
              tx,
              'SELECT id,format,status,snapshot_at,completed_at,error_code,created_at FROM school_exports WHERE school_id=$1 ORDER BY created_at DESC,id',
              [a.context.schoolId],
              req.query,
            ),
          true,
        ),
      );
    }),
  );
  r.get(
    '/exports/:id',
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        id = uuid.parse(req.params.id);
      const row = await transaction(
        pool,
        a.context,
        async (tx) =>
          (
            await tx.query(
              "SELECT * FROM school_exports WHERE school_id=$1 AND id=$2 AND status='COMPLETED'",
              [a.context.schoolId, id],
            )
          ).rows[0],
        true,
      );
      if (!row) throw notFound();
      res.json({
        id,
        status: row.status,
        snapshot_at: row.snapshot_at,
        files: row.manifest.map(
          (f: { name: string; sha256: string; bytes: number }, i: number) => ({
            index: i,
            name: f.name,
            sha256: f.sha256,
            bytes: f.bytes,
            ...signedDownload(key, `/exports/${id}/files/${i}`, a.id, a.context.schoolId),
          }),
        ),
      });
    }),
  );
  r.get(
    '/exports/:id/files/:index',
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        id = uuid.parse(req.params.id),
        index = z.coerce.number().int().min(0).max(100000).parse(req.params.index);
      verifyDownload(
        key,
        `/exports/${id}/files/${index}`,
        a.id,
        a.context.schoolId,
        req.query.expires,
        req.query.signature,
      );
      const file = await transaction(pool, a.context, async (tx) => {
        const row = (
          await tx.query(
            "SELECT manifest FROM school_exports WHERE school_id=$1 AND id=$2 AND status='COMPLETED'",
            [a.context.schoolId, id],
          )
        ).rows[0];
        const f = row?.manifest[index];
        if (!f || !f.path.startsWith(`${a.context.schoolId}/exports/${id}/`)) throw notFound();
        await audit(tx, a.context.schoolId, a.id, 'school.export_download', 'school_exports', id);
        return f;
      });
      const object = await storage.storage.from('school-documents').download(file.path);
      if (object.error)
        throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'Export file is unavailable.');
      res.setHeader('Content-Type', object.data.type || 'application/octet-stream');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${String(file.name).replace(/[^a-zA-Z0-9._-]/g, '_')}"`,
      );
      res.send(Buffer.from(await object.data.arrayBuffer()));
    }),
  );
  return r;
}
