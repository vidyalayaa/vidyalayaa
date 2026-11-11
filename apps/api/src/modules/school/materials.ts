import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { transaction } from '../../lib/db.js';
import { paged } from '../../lib/pagination.js';
import { asyncRoute, ApiError, notFound } from '../../lib/errors.js';
import type { Actor } from '../../middleware/auth.js';
import { assertClass, resourceScope } from './resources.js';

// A projection of the existing assignments, not another materials catalogue.
// The parent workspace mounts the same read handler behind its checked child.
export function subjectMaterialsRouter(pool: pg.Pool) {
  const r = Router();
  r.get(
    '/',
    asyncRoute(async (req, res) => {
      const a: Actor = res.locals.actor;
      if (!a.active?.permissions.includes('assignments.read'))
        throw new ApiError(403, 'FORBIDDEN', 'Study material access required.');
      if (!a.features.assignments)
        throw new ApiError(
          403,
          'SUBSCRIPTION_FEATURE_UNAVAILABLE',
          'Your plan does not include study materials.',
        );
      const q = z
        .object({
          class_id: z.guid(),
          subject_id: z.guid(),
          page: z.coerce.number().int().min(1).max(100000).default(1),
          page_size: z.coerce.number().int().min(1).max(100).default(25),
        })
        .strict()
        .parse(req.query);
      const result = await transaction(
        pool,
        a.context,
        async (tx) => {
          await assertClass(
            tx,
            a,
            q.class_id,
            a.active!.role === 'teacher' ? q.subject_id : undefined,
          );
          if (
            !(
              await tx.query(
                `SELECT sub.id FROM subjects sub WHERE sub.school_id=$1 AND sub.id=$2 AND sub.retired_at IS NULL
        AND EXISTS(SELECT FROM teacher_class_assignments ta JOIN schools sc ON sc.id=ta.school_id
        WHERE ta.school_id=sub.school_id AND ta.subject_id=sub.id AND ta.class_id=$3 AND ta.retired_at IS NULL
        AND ta.starts_on<=(now() AT TIME ZONE sc.timezone)::date AND (ta.ends_on IS NULL OR ta.ends_on>=(now() AT TIME ZONE sc.timezone)::date))`,
                [a.context.schoolId, q.subject_id, q.class_id],
              )
            ).rowCount
          )
            throw notFound();
          return paged(
            tx,
            `SELECT t.id,t.title,t.body,t.created_at,(t.storage_path IS NOT NULL) AS has_attachment,
        CASE WHEN t.storage_path IS NOT NULL THEN regexp_replace(t.storage_path,'^.*/','') ELSE NULL END AS filename
        FROM assignments t WHERE t.school_id=$1 AND t.class_id=$3 AND t.subject_id=$4 AND t.kind='MATERIAL'
        AND ${resourceScope('assignments', a)} ORDER BY t.created_at DESC,t.id`,
            [a.context.schoolId, a.id, q.class_id, q.subject_id],
            q,
          );
        },
        true,
      );
      res.setHeader('Cache-Control', 'no-store');
      res.json(result);
    }),
  );
  return r;
}
