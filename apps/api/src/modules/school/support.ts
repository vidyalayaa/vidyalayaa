import { Router } from 'express';
import type pg from 'pg';
import { supportRequestSchema } from '@vidyalayaa/contracts';
import { permission } from '../../middleware/auth.js';
import { asyncRoute, ApiError } from '../../lib/errors.js';
import { transaction } from '../../lib/db.js';
import { paged } from '../../lib/pagination.js';
import { withIdempotency } from './router.js';
export function supportRouter(pool: pg.Pool) {
  const r = Router();
  r.get(
    '/support-requests',
    permission('users.manage'),
    asyncRoute(async (req, res) => {
      const a = res.locals.actor;
      res.json(
        await transaction(
          pool,
          a.context,
          (tx) =>
            paged(
              tx,
              'SELECT id,subject,category,description,status,response,created_at,updated_at FROM support_requests WHERE school_id=$1 ORDER BY updated_at DESC,id',
              [a.context.schoolId],
              req.query,
            ),
          true,
        ),
      );
    }),
  );
  r.post(
    '/support-requests',
    permission('users.manage'),
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        b = supportRequestSchema.parse(req.body);
      const result = await transaction(pool, a.context, (tx) =>
        withIdempotency(tx, a, req.header('Idempotency-Key'), b, async () => {
          await tx.query('SELECT id FROM schools WHERE id=$1 FOR UPDATE', [a.context.schoolId]);
          if (
            Number(
              (
                await tx.query(
                  "SELECT count(*) FROM support_requests WHERE school_id=$1 AND status<>'RESOLVED'",
                  [a.context.schoolId],
                )
              ).rows[0].count,
            ) >= 20
          )
            throw new ApiError(
              409,
              'SUPPORT_QUEUE_FULL',
              'Resolve existing requests before opening another.',
            );
          return (
            await tx.query(
              'INSERT INTO support_requests(school_id,requested_by,subject,category,description) VALUES($1,$2,$3,$4,$5) RETURNING id,status',
              [a.context.schoolId, a.id, b.subject, b.category, b.description],
            )
          ).rows[0];
        }),
      );
      res.status(201).json(result);
    }),
  );
  return r;
}
