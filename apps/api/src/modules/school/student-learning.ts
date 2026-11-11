import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import type { StudentAcademics, StudentResultRecord, StudentResults } from '@vidyalayaa/contracts';
import { transaction, type Tx } from '../../lib/db.js';
import { asyncRoute, ApiError, notFound } from '../../lib/errors.js';
import type { Actor } from '../../middleware/auth.js';
import { resultCharts } from './parent-insights.js';

async function ownStudent(tx: Tx, a: Actor) {
  const row = (
    await tx.query(
      "SELECT id FROM students WHERE school_id=$1 AND user_id=$2 AND status='ACTIVE'",
      [a.context.schoolId, a.id],
    )
  ).rows[0];
  if (!row) throw notFound();
  return row.id as string;
}

// Mounted behind the student-profile role gate. IDs always come from the
// authenticated account, with the regular non-bypass transaction role and RLS.
export function studentLearningRouter(pool: pg.Pool) {
  const r = Router();
  r.get(
    '/academics',
    asyncRoute(async (req, res) => {
      z.object({}).strict().parse(req.query);
      const a: Actor = res.locals.actor;
      if (!a.active!.permissions.includes('academics.read'))
        throw new ApiError(403, 'FORBIDDEN', 'Academic access required.');
      const data = await transaction(
        pool,
        a.context,
        async (tx) => {
          const student = await ownStudent(tx, a);
          const classes = (
            await tx.query(
              `SELECT c.id AS class_id,c.grade,c.section,e.roll_number,ac.name AS session_name,
         ac.starts_on::text AS session_starts_on,ac.ends_on::text AS session_ends_on,ct.full_name AS class_teacher
         FROM enrollments e JOIN classes c ON c.school_id=e.school_id AND c.id=e.class_id
         JOIN academic_sessions ac ON ac.school_id=e.school_id AND ac.id=e.academic_session_id
         JOIN schools sc ON sc.id=e.school_id
         LEFT JOIN teachers ct ON ct.school_id=c.school_id AND ct.id=c.class_teacher_id AND ct.status='ACTIVE'
         WHERE e.school_id=$1 AND e.student_id=$2 AND e.status='ACTIVE' AND c.retired_at IS NULL AND ac.retired_at IS NULL
         AND (now() AT TIME ZONE sc.timezone)::date BETWEEN ac.starts_on AND ac.ends_on
         AND e.starts_on<=(now() AT TIME ZONE sc.timezone)::date
         AND (e.ends_on IS NULL OR e.ends_on>=(now() AT TIME ZONE sc.timezone)::date)
         ORDER BY c.grade,c.section,e.id`,
              [a.context.schoolId, student],
            )
          ).rows;
          for (const classroom of classes) {
            classroom.subjects = (
              await tx.query(
                `SELECT sub.id,sub.name,sub.code,
           coalesce(array_agg(DISTINCT te.full_name ORDER BY te.full_name) FILTER(WHERE te.id IS NOT NULL),'{}') AS teachers
           FROM teacher_class_assignments ta JOIN subjects sub ON sub.school_id=ta.school_id AND sub.id=ta.subject_id
           JOIN schools sc ON sc.id=ta.school_id
           LEFT JOIN teachers te ON te.school_id=ta.school_id AND te.id=ta.teacher_id AND te.status='ACTIVE'
           WHERE ta.school_id=$1 AND ta.class_id=$2 AND ta.retired_at IS NULL AND sub.retired_at IS NULL
           AND ta.starts_on<=(now() AT TIME ZONE sc.timezone)::date
           AND (ta.ends_on IS NULL OR ta.ends_on>=(now() AT TIME ZONE sc.timezone)::date)
           GROUP BY sub.id,sub.name,sub.code ORDER BY sub.name,sub.id`,
                [a.context.schoolId, classroom.class_id],
              )
            ).rows;
          }
          return { classes } as StudentAcademics;
        },
        true,
      );
      res.setHeader('Cache-Control', 'no-store');
      res.json(data);
    }),
  );
  r.get(
    '/results',
    asyncRoute(async (req, res) => {
      const filters = z
        .object({
          exam_id: z.guid().optional(),
          subject_id: z.guid().optional(),
          page: z.coerce.number().int().min(1).max(100000).default(1),
          page_size: z.coerce.number().int().min(1).max(100).default(25),
        })
        .strict()
        .parse(req.query);
      const a: Actor = res.locals.actor;
      if (!a.active!.permissions.includes('marks.read'))
        throw new ApiError(403, 'FORBIDDEN', 'Results access required.');
      const data = await transaction(
        pool,
        a.context,
        async (tx) => {
          const student = await ownStudent(tx, a);
          const rows = (
            await tx.query<StudentResultRecord>(
              `SELECT m.id,m.exam_id,m.subject_id,ex.name AS examination,ex.assessment_kind,ex.exam_type,
         ex.starts_on::text AS exam_date,coalesce(ex.starts_on,(ex.created_at AT TIME ZONE $3)::date)::text AS result_date,
         sub.name AS subject,m.score::float8,ex.max_score::float8,m.remarks,c.grade,c.section,ac.name AS session_name
         FROM marks m JOIN exams ex ON ex.school_id=m.school_id AND ex.id=m.exam_id
         JOIN subjects sub ON sub.school_id=m.school_id AND sub.id=m.subject_id
         JOIN classes c ON c.school_id=ex.school_id AND c.id=ex.class_id
         JOIN academic_sessions ac ON ac.school_id=c.school_id AND ac.id=c.academic_session_id
         WHERE m.school_id=$1 AND m.student_id=$2 AND ex.status='PUBLISHED' AND ex.retired_at IS NULL
         ORDER BY result_date DESC,ex.name,sub.name,m.id`,
              [a.context.schoolId, student, a.active!.timezone],
            )
          ).rows;
          const filtered = rows.filter(
            (row) =>
              (!filters.exam_id || row.exam_id === filters.exam_id) &&
              (!filters.subject_id || row.subject_id === filters.subject_id),
          );
          return {
            data: filtered.slice(
              (filters.page - 1) * filters.page_size,
              filters.page * filters.page_size,
            ),
            total: filtered.length,
            page: filters.page,
            page_size: filters.page_size,
            exams: [
              ...new Map(
                rows.map((row) => [row.exam_id, { id: row.exam_id, name: row.examination }]),
              ).values(),
            ],
            subjects: [
              ...new Map(
                rows.map((row) => [row.subject_id, { id: row.subject_id, name: row.subject }]),
              ).values(),
            ],
            ...resultCharts(filtered),
          } satisfies StudentResults;
        },
        true,
      );
      res.setHeader('Cache-Control', 'no-store');
      res.json(data);
    }),
  );
  r.all(['/academics', '/results'], (_req, _res, next) =>
    next(new ApiError(405, 'METHOD_NOT_ALLOWED', 'Student academic records are read-only.')),
  );
  return r;
}
