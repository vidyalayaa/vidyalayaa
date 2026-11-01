import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { date, uuid } from '@vidyalayaa/contracts';
import { transaction, audit, type Tx } from '../../lib/db.js';
import { asyncRoute, ApiError, notFound } from '../../lib/errors.js';
import type { Actor } from '../../middleware/auth.js';
import { resourceScope } from './resources.js';

export async function scheduleHomework(tx: Tx, school: string, row: Record<string, any>) {
  if (row.kind !== 'HOMEWORK' || row.retired_at) return;
  await tx.query(
    `INSERT INTO notification_outbox(school_id,kind,dedupe_key,payload,created_by,next_attempt_at)
    VALUES($1,'HOMEWORK',$2,$3::jsonb || jsonb_build_object('event_time',greatest(now(),($5::date::timestamp AT TIME ZONE (SELECT timezone FROM schools WHERE id=$1)))),$4,greatest(now(),($5::date::timestamp AT TIME ZONE (SELECT timezone FROM schools WHERE id=$1)))) ON CONFLICT(school_id,dedupe_key) DO NOTHING`,
    [
      school,
      `HOMEWORK:${row.id}:${row.diary_version}`,
      {
        homework_id: row.id,
        revision: row.diary_version,
        class_id: row.class_id,
        title: row.title,
        event_time: new Date(row.updated_at).toISOString(),
      },
      row.created_by,
      row.assigned_on,
    ],
  );
}
export function homeworkRouter(
  pool: pg.Pool,
  write?: (tx: Tx, a: Actor, feature?: string) => Promise<void>,
) {
  const r = Router();
  r.get(
    '/diary',
    asyncRoute(async (req, res) => {
      const a: Actor = res.locals.actor;
      if (!a.active?.permissions.includes('assignments.read'))
        throw new ApiError(403, 'FORBIDDEN', 'Homework access required.');
      if (!a.features.assignments)
        throw new ApiError(
          403,
          'SUBSCRIPTION_FEATURE_UNAVAILABLE',
          'Your plan does not include homework.',
        );
      const q = z
        .object({
          date: date.refine((value) => {
            const parsed = new Date(value + 'T12:00:00Z');
            return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
          }, 'Choose a valid date.'),
          kind: z.enum(['HOMEWORK', 'MATERIAL']).default('HOMEWORK'),
          class_id: uuid.optional(),
          page: z.coerce.number().int().min(1).default(1),
        })
        .strict()
        .parse(req.query);
      res.json(
        await transaction(
          pool,
          a.context,
          async (tx) => {
            const params = [a.context.schoolId, a.id, q.date, q.class_id || null];
            const scope = `t.school_id=$1 AND t.kind='${q.kind}' AND ($4::uuid IS NULL OR t.class_id=$4) AND ${resourceScope('assignments', a)}`;
            const dates = (
              await tx.query(
                `SELECT t.assigned_on::text AS date,count(*)::int AS count FROM assignments t WHERE ${scope} AND t.assigned_on>=date_trunc('month',$3::date)::date AND t.assigned_on<(date_trunc('month',$3::date)+interval '1 month')::date GROUP BY t.assigned_on ORDER BY t.assigned_on`,
                params,
              )
            ).rows;
            const total = Number(
              (
                await tx.query(
                  `SELECT count(*) FROM assignments t WHERE ${scope} AND t.assigned_on=$3::date`,
                  params,
                )
              ).rows[0].count,
            );
            const data = (
              await tx.query(
                `SELECT t.*,t.assigned_on::text AS assigned_on,s.name AS subject,c.grade,c.section FROM assignments t JOIN classes c ON c.school_id=t.school_id AND c.id=t.class_id LEFT JOIN subjects s ON s.school_id=t.school_id AND s.id=t.subject_id WHERE ${scope} AND t.assigned_on=$3::date ORDER BY s.name NULLS LAST,t.created_at,t.id LIMIT 50 OFFSET $5`,
                [...params, (q.page - 1) * 50],
              )
            ).rows;
            const classes = (
              await tx.query(
                `SELECT t.id,t.grade,t.section FROM classes t WHERE t.school_id=$1 AND ${resourceScope('classes', a)} ORDER BY t.grade,t.section`,
                params.slice(0, 2),
              )
            ).rows;
            return { data, dates, classes, total, page: q.page, page_size: 50 };
          },
          true,
        ),
      );
    }),
  );
  r.delete(
    '/:id',
    asyncRoute(async (req, res) => {
      const a: Actor = res.locals.actor;
      if (
        !write ||
        !['school_admin', 'teacher'].includes(a.active?.role || '') ||
        !a.active?.permissions.includes('assignments.write')
      )
        throw new ApiError(403, 'FORBIDDEN', 'You cannot delete homework.');
      const id = uuid.parse(req.params.id);
      await transaction(pool, a.context, async (tx) => {
        await write(tx, a, 'assignments');
        const result = await tx.query(
          `UPDATE assignments t SET retired_at=now() WHERE t.school_id=$1 AND t.id=$3 AND t.kind='HOMEWORK' AND ${resourceScope('assignments', a)} RETURNING t.id`,
          [a.context.schoolId, a.id, id],
        );
        if (!result.rowCount) throw notFound();
        await audit(tx, a.context.schoolId, a.id, 'homework.retire', 'assignments', id);
      });
      res.json({ deleted: true });
    }),
  );
  return r;
}
