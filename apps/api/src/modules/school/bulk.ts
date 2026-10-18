import { Router } from 'express';
import type pg from 'pg';
import { bulkMarksSchema } from '@vidyalayaa/contracts';
import { permission } from '../../middleware/auth.js';
import { asyncRoute, ApiError, notFound } from '../../lib/errors.js';
import { transaction, audit } from '../../lib/db.js';
import { requireWrite, withIdempotency } from './router.js';
import { assertClass } from './resources.js';
export function bulkRouter(pool: pg.Pool) {
  const r = Router();
  r.post(
    '/marks/bulk',
    permission('marks.write'),
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        b = bulkMarksSchema.parse(req.body);
      res.json(
        await transaction(pool, a.context, async (tx) => {
          await requireWrite(tx, a);
          return withIdempotency(tx, a, req.header('Idempotency-Key'), b, async () => {
            const ex = (
              await tx.query('SELECT * FROM exams WHERE school_id=$1 AND id=$2 FOR UPDATE', [
                a.context.schoolId,
                b.exam_id,
              ])
            ).rows[0];
            if (!ex) throw notFound();
            if (ex.status !== 'OPEN')
              throw new ApiError(409, 'EXAM_LOCKED', 'Only open exams accept marks.');
            await assertClass(tx, a, ex.class_id);
            for (const subject of new Set(b.entries.map((x) => x.subject_id)))
              await assertClass(tx, a, ex.class_id, subject);
            const students = [...new Set(b.entries.map((x) => x.student_id))];
            const en = await tx.query(
              "SELECT DISTINCT student_id FROM enrollments WHERE school_id=$1 AND class_id=$2 AND student_id=ANY($3::uuid[]) AND status='ACTIVE'",
              [a.context.schoolId, ex.class_id, students],
            );
            const valid = new Set(en.rows.map((x) => x.student_id));
            const invalid = b.entries
              .map((entry, index) => ({ row: index + 1, entry }))
              .filter(
                (x) => !valid.has(x.entry.student_id) || x.entry.score > Number(ex.max_score),
              );
            if (invalid.length)
              throw new ApiError(
                422,
                'BULK_VALIDATION_FAILED',
                `No rows saved. Invalid enrollment or score at rows: ${invalid
                  .slice(0, 20)
                  .map((x) => x.row)
                  .join(', ')}.`,
              );
            const saved = await tx.query(
              'INSERT INTO marks(school_id,exam_id,student_id,subject_id,score,remarks,entered_by) SELECT $1,$2,x.student_id,x.subject_id,x.score,x.remarks,$3 FROM jsonb_to_recordset($4::jsonb) x(student_id uuid,subject_id uuid,score numeric,remarks text) ON CONFLICT(school_id,exam_id,student_id,subject_id) DO UPDATE SET score=EXCLUDED.score,remarks=EXCLUDED.remarks,entered_by=EXCLUDED.entered_by RETURNING id',
              [a.context.schoolId, b.exam_id, a.id, JSON.stringify(b.entries)],
            );
            await audit(tx, a.context.schoolId, a.id, 'marks.bulk', 'exams', ex.id);
            return { saved: saved.rowCount };
          });
        }),
      );
    }),
  );
  return r;
}
