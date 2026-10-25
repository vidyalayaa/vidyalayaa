import { Router } from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type pg from 'pg';
import { z } from 'zod';
import { studentAdmissionSchema, studentImportRequestSchema, uuid } from '@vidyalayaa/contracts';
import { transaction, type Tx } from '../../lib/db.js';
import { asyncRoute, ApiError, notFound } from '../../lib/errors.js';
import type { Actor } from '../../middleware/auth.js';
import { paged } from '../../lib/pagination.js';
import { saveStudentAdmission } from './student-admissions.js';
import { importStudentAdmissions } from './student-import.js';
import { studentExportRows } from './student-export.js';

interface WriteControls {
  requireWrite: (tx: Tx, a: Actor, feature?: string) => Promise<void>;
  withIdempotency: <T>(
    tx: Tx,
    a: Actor,
    key: string | undefined,
    body: unknown,
    fn: () => Promise<T>,
  ) => Promise<T>;
}
// One placement rule for class counts, rosters and the unassigned bucket. Keep
// inactive students visible: changing status must not hide a school record.
const placement = `e.status='ACTIVE' AND c.retired_at IS NULL
 AND e.starts_on<=(now() AT TIME ZONE sc.timezone)::date
 AND (e.ends_on IS NULL OR e.ends_on>=(now() AT TIME ZONE sc.timezone)::date)`;
const matches = `concat_ws(' ',s.student_code,s.first_name,s.last_name,s.email::text) ILIKE $2`;
export function studentDirectoryRouter(pool: pg.Pool, writes: WriteControls) {
  const r = Router();
  r.use((_req, res, next) => {
    const a: Actor = res.locals.actor;
    if (
      a.active?.role !== 'school_admin' ||
      !['students.read', 'parents.read', 'academics.read'].every((p) =>
        a.active!.permissions.includes(p),
      )
    )
      return next(
        new ApiError(403, 'FORBIDDEN', 'School Admin student management access is required.'),
      );
    next();
  });
  r.get(
    '/parents',
    asyncRoute(async (req, res) => {
      const a: Actor = res.locals.actor,
        q = z.object({ search: z.string().max(120).default('') }).parse(req.query);
      res.json(
        await transaction(
          pool,
          a.context,
          (tx) =>
            paged(
              tx,
              "SELECT id,full_name,email,phone FROM parents WHERE school_id=$1 AND status='ACTIVE' AND concat_ws(' ',full_name,email::text,phone) ILIKE $2 ORDER BY full_name,id",
              [a.context.schoolId, `%${q.search}%`],
              req.query,
            ),
          true,
        ),
      );
    }),
  );
  r.get(
    '/enrollment-classes',
    asyncRoute(async (req, res) => {
      const a: Actor = res.locals.actor,
        q = z.object({ search: z.string().max(120).default('') }).parse(req.query);
      res.json(
        await transaction(
          pool,
          a.context,
          (tx) =>
            paged(
              tx,
              "SELECT c.id,concat('Class ',c.grade,' · Section ',c.section,' · ',ac.name) AS name FROM classes c JOIN academic_sessions ac ON ac.school_id=c.school_id AND ac.id=c.academic_session_id WHERE c.school_id=$1 AND c.retired_at IS NULL AND ac.retired_at IS NULL AND concat_ws(' ',c.grade,c.section,ac.name) ILIKE $2 ORDER BY ac.starts_on DESC,c.grade,c.section,c.id",
              [a.context.schoolId, `%${q.search}%`],
              req.query,
            ),
          true,
        ),
      );
    }),
  );
  r.get(
    '/classes',
    asyncRoute(async (req, res) => {
      const a: Actor = res.locals.actor,
        q = z.object({ search: z.string().max(120).default('') }).parse(req.query);
      res.json(
        await transaction(
          pool,
          a.context,
          async (tx) => ({
            ...(await paged(
              tx,
              `SELECT c.id,c.grade,c.section,c.academic_session_id,ac.name AS session_name,ac.is_current,
       (SELECT count(DISTINCT s.id)::int FROM enrollments e JOIN students s ON s.school_id=e.school_id AND s.id=e.student_id WHERE e.school_id=c.school_id AND e.class_id=c.id AND ${placement} AND ${matches}) AS student_count
       FROM classes c JOIN academic_sessions ac ON ac.school_id=c.school_id AND ac.id=c.academic_session_id JOIN schools sc ON sc.id=c.school_id
       WHERE c.school_id=$1 AND c.retired_at IS NULL ORDER BY ac.starts_on DESC,c.grade,c.section,c.id`,
              [a.context.schoolId, `%${q.search}%`],
              req.query,
            )),
            unassigned_count: Number(
              (
                await tx.query(
                  `SELECT count(*) FROM students s JOIN schools sc ON sc.id=s.school_id WHERE s.school_id=$1 AND ${matches} AND NOT EXISTS(SELECT FROM enrollments e JOIN classes c ON c.school_id=e.school_id AND c.id=e.class_id WHERE e.school_id=s.school_id AND e.student_id=s.id AND ${placement})`,
                  [a.context.schoolId, `%${q.search}%`],
                )
              ).rows[0].count,
            ),
          }),
          true,
        ),
      );
    }),
  );
  r.get(
    '/students',
    asyncRoute(async (req, res) => {
      const a: Actor = res.locals.actor,
        q = z
          .object({
            class_id: uuid.optional(),
            unassigned: z.literal('1').optional(),
            search: z.string().max(120).default(''),
          })
          .refine((v) => !!v.class_id !== !!v.unassigned, 'Select a class or the unassigned group.')
          .parse(req.query);
      res.json(
        await transaction(
          pool,
          a.context,
          async (tx) => {
            if (
              q.class_id &&
              !(
                await tx.query(
                  'SELECT id FROM classes WHERE school_id=$1 AND id=$2 AND retired_at IS NULL',
                  [a.context.schoolId, q.class_id],
                )
              ).rowCount
            )
              throw notFound();
            return paged(
              tx,
              `SELECT s.*,selected.id AS enrollment_id,selected.roll_number,selected.starts_on,selected.ends_on
       FROM students s JOIN schools sc ON sc.id=s.school_id
       LEFT JOIN LATERAL(SELECT e.* FROM enrollments e JOIN classes c ON c.school_id=e.school_id AND c.id=e.class_id WHERE e.school_id=s.school_id AND e.student_id=s.id AND ${placement} AND ($3::uuid IS NULL OR c.id=$3) ORDER BY e.starts_on DESC,e.id LIMIT 1) selected ON true
       WHERE s.school_id=$1 AND ${matches} AND ${q.class_id ? 'selected.id IS NOT NULL' : 'selected.id IS NULL'} ORDER BY s.first_name,s.last_name,s.student_code,s.id`,
              [a.context.schoolId, `%${q.search}%`, q.class_id || null],
              req.query,
            );
          },
          true,
        ),
      );
    }),
  );
  r.post(
    '/imports',
    asyncRoute(async (req, res) => {
      const a: Actor = res.locals.actor,
        b = studentImportRequestSchema.parse(req.body),
        key = req.header('Idempotency-Key');
      if (
        !['users.manage', 'students.write', 'parents.write'].every((p) =>
          a.active!.permissions.includes(p),
        )
      )
        throw new ApiError(403, 'FORBIDDEN', 'Student and family import permissions are required.');
      if (!b.validate_only && !key)
        throw new ApiError(
          422,
          'IDEMPOTENCY_KEY_REQUIRED',
          'A retry key is required to import students safely.',
        );
      const result = await transaction(pool, a.context, async (tx) => {
        await writes.requireWrite(tx, a);
        const run = () => importStudentAdmissions(tx, a, b.rows, b.validate_only);
        return b.validate_only
          ? run()
          : writes.withIdempotency(tx, a, key, { operation: 'student.import', rows: b.rows }, run);
      });
      res.status(b.validate_only ? 200 : 201).json(result);
    }),
  );
  r.get(
    '/export.csv',
    asyncRoute(async (req, res) => {
      const a: Actor = res.locals.actor;
      const q = z
        .object({
          search: z.string().trim().max(120).default(''),
          academic_session_id: uuid.optional(),
        })
        .strict()
        .parse(req.query);
      // Directory middleware already requires a School Admin and student/parent read permissions.
      res.type('text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="vidyalayaa-students.csv"');
      res.setHeader('Cache-Control', 'no-store');
      try {
        await transaction(
          pool,
          a.context,
          (tx) =>
            pipeline(
              Readable.from(
                studentExportRows(tx, a.context.schoolId, q.search, q.academic_session_id),
              ),
              res,
            ),
          true,
          'repeatable read',
        );
      } catch (error) {
        if (res.headersSent || res.destroyed) {
          res.destroy();
          return;
        }
        res.removeHeader('Content-Disposition');
        throw error;
      }
    }),
  );
  r.post(
    '/admissions',
    asyncRoute(async (req, res) => {
      const a: Actor = res.locals.actor,
        b = studentAdmissionSchema.parse(req.body),
        key = req.header('Idempotency-Key');
      if (!['students.write', 'parents.write'].every((p) => a.active!.permissions.includes(p)))
        throw new ApiError(
          403,
          'FORBIDDEN',
          'Student and parent management permissions are required.',
        );
      if (!key)
        throw new ApiError(
          422,
          'IDEMPOTENCY_KEY_REQUIRED',
          'A retry key is required to save this admission safely.',
        );
      const data = await transaction(pool, a.context, async (tx) => {
        await writes.requireWrite(tx, a);
        return writes.withIdempotency(
          tx,
          a,
          key,
          { operation: 'student.admission', ...b },
          async () => {
            return saveStudentAdmission(tx, a, b);
          },
        );
      });
      res.status(201).json(data);
    }),
  );
  return r;
}
