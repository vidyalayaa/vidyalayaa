import { Router } from 'express';
import { homeworkRouter } from './homework.js';
import type pg from 'pg';
import {
  uuid,
  pageSchema,
  parentDateRangeSchema,
  parentAttendanceFilterSchema,
  parentResultsFilterSchema,
  type ParentAttendanceDay,
  type ParentResultRecord,
} from '@vidyalayaa/contracts';
import { attendanceSummary, resultCharts } from './parent-insights.js';
import { localParts } from '../attendance/engine.js';
import { transaction } from '../../lib/db.js';
import { paged } from '../../lib/pagination.js';
import { asyncRoute, ApiError, notFound } from '../../lib/errors.js';
import { calendarRouter } from './calendar.js';
import { timetableRouter } from './timetable.js';
import type { Actor } from '../../middleware/auth.js';
import { subjectMaterialsRouter } from './materials.js';

const childSelect = `SELECT s.id,s.student_code,s.first_name,s.last_name,s.date_of_birth::text,s.gender,s.email,s.status,s.profile_photo_id,d.details AS contact,
 (SELECT jsonb_build_object('class_id',c.id,'grade',c.grade,'section',c.section,'session_name',ac.name,
 'academic_session_id',ac.id,'session_starts_on',ac.starts_on::text,'roll_number',e.roll_number,'class_teacher',te.full_name)
 FROM enrollments e JOIN classes c ON c.school_id=e.school_id AND c.id=e.class_id
 JOIN academic_sessions ac ON ac.school_id=c.school_id AND ac.id=c.academic_session_id
 LEFT JOIN teachers te ON te.school_id=c.school_id AND te.id=c.class_teacher_id
 WHERE e.school_id=s.school_id AND e.student_id=s.id AND e.status='ACTIVE' AND c.retired_at IS NULL AND ac.retired_at IS NULL
 AND e.starts_on<=(now() AT TIME ZONE (SELECT timezone FROM schools WHERE id=s.school_id))::date
 AND (e.ends_on IS NULL OR e.ends_on>=(now() AT TIME ZONE (SELECT timezone FROM schools WHERE id=s.school_id))::date)
 ORDER BY e.starts_on DESC,e.id LIMIT 1) AS enrollment FROM students s
 LEFT JOIN school_person_details d ON d.school_id=s.school_id AND d.student_id=s.id`;

// The existing records remain the source of truth. This router only projects
// parent-facing fields, with both a checked child ID and restrictive database RLS.
export function parentWorkspaceRouter(pool: pg.Pool) {
  const r = Router();
  r.use((_req, res, next) => {
    const a: Actor = res.locals.actor;
    if (a.active?.role !== 'parent')
      return next(new ApiError(403, 'FORBIDDEN', 'Parent account required.'));
    next();
  });
  r.get(
    '/children',
    asyncRoute(async (_req, res) => {
      const a: Actor = res.locals.actor;
      res.json(
        await transaction(
          pool,
          a.context,
          async (tx) => ({
            children: (
              await tx.query(
                `${childSelect} WHERE s.school_id=$1 AND app.parent_student_access(s.school_id,s.id) ORDER BY s.first_name,s.last_name,s.id`,
                [a.context.schoolId],
              )
            ).rows,
          }),
          true,
        ),
      );
    }),
  );
  r.use(
    '/children/:childId',
    asyncRoute(async (req, res, next) => {
      const a: Actor = res.locals.actor,
        id = uuid.parse(req.params.childId);
      const allowed = await transaction(
        pool,
        a.context,
        async (tx) =>
          (
            await tx.query('SELECT app.parent_student_access($1,$2) AS allowed', [
              a.context.schoolId,
              id,
            ])
          ).rows[0]?.allowed,
        true,
      );
      if (!allowed) throw notFound();
      a.context = { ...a.context, parentChildId: id };
      if (req.method !== 'GET')
        throw new ApiError(403, 'FORBIDDEN', 'Parents cannot change official school records.');
      next();
    }),
  );
  const child = Router({ mergeParams: true });
  // These mature read-only calendar and weekly-grid APIs now inherit the checked
  // child transaction scope. Their existing write gates remain in force as well.
  const noWrite = async () => {
    throw new ApiError(403, 'FORBIDDEN', 'Read-only parent workspace.');
  };
  const controls = {
    requireWrite: noWrite,
    withIdempotency: async <T>(..._args: unknown[]): Promise<T> => noWrite(),
  };
  child.use('/calendar', calendarRouter(pool, controls));
  child.use('/timetable', timetableRouter(pool, controls));
  child.use('/materials', subjectMaterialsRouter(pool));
  child.use('/homework', homeworkRouter(pool));
  function range(a: Actor, filters: { from?: string; to?: string }, year = false) {
    const today = localParts(new Date(), a.active!.timezone).date;
    const from =
      filters.from ||
      (year
        ? new Date(Date.parse(today + 'T12:00:00Z') - 364 * 86400000).toISOString().slice(0, 10)
        : today.slice(0, 7) + '-01');
    const to = filters.to || today;
    parentDateRangeSchema.parse({ from, to });
    if (from > today)
      throw new ApiError(422, 'INVALID_DATE_RANGE', 'Choose a start date on or before today.');
    return { from, to: to > today ? today : to };
  }
  child.get(
    '/attendance',
    asyncRoute(async (req, res) => {
      const a: Actor = res.locals.actor;
      if (!a.active!.permissions.includes('attendance.read'))
        throw new ApiError(403, 'FORBIDDEN', 'Attendance access required.');
      const filters = parentAttendanceFilterSchema.parse(req.query),
        dates = range(a, filters),
        page = pageSchema.parse(req.query);
      res.json(
        await transaction(
          pool,
          a.context,
          async (tx) => {
            const days = (
              await tx.query<ParentAttendanceDay>(
                'SELECT * FROM app.parent_attendance_days($1,$2,$3)',
                [a.context.parentChildId, dates.from, dates.to],
              )
            ).rows;
            const filtered = filters.status
              ? days.filter((d) => d.attendance_status === filters.status)
              : days;
            return {
              data: filtered.slice((page.page - 1) * page.page_size, page.page * page.page_size),
              total: filtered.length,
              page: page.page,
              page_size: page.page_size,
              summary: attendanceSummary(days),
              range: dates,
              uses_default_schedule: days.some(
                (d) => d.school_day && d.schedule_source === 'DEFAULT',
              ),
            };
          },
          true,
        ),
      );
    }),
  );
  child.get(
    '/results/insights',
    asyncRoute(async (req, res) => {
      const a: Actor = res.locals.actor;
      if (!a.active!.permissions.includes('marks.read'))
        throw new ApiError(403, 'FORBIDDEN', 'Results access required.');
      const filters = parentResultsFilterSchema.parse(req.query),
        dates = range(a, filters, true);
      res.json(
        await transaction(
          pool,
          a.context,
          async (tx) => {
            const rows = (
              await tx.query<ParentResultRecord>(
                `SELECT m.id,m.exam_id,m.subject_id,ex.name AS examination,ex.assessment_kind,ex.exam_type,
      ex.starts_on::text AS exam_date,coalesce(ex.starts_on,(ex.created_at AT TIME ZONE $5)::date)::text AS result_date,s.name AS subject,m.score::float8,m.remarks,ex.max_score::float8
      FROM marks m JOIN exams ex ON ex.school_id=m.school_id AND ex.id=m.exam_id JOIN subjects s ON s.school_id=m.school_id AND s.id=m.subject_id
      WHERE m.school_id=$1 AND m.student_id=$2 AND ex.status='PUBLISHED' AND ex.retired_at IS NULL
      AND coalesce(ex.starts_on,(ex.created_at AT TIME ZONE $5)::date) BETWEEN $3::date AND $4::date ORDER BY result_date,ex.name,s.name,m.id`,
                [
                  a.context.schoolId,
                  a.context.parentChildId,
                  dates.from,
                  dates.to,
                  a.active!.timezone,
                ],
              )
            ).rows;
            const data = rows.filter(
              (r) =>
                (!filters.exam_id || r.exam_id === filters.exam_id) &&
                (!filters.subject_id || r.subject_id === filters.subject_id),
            );
            return {
              data,
              range: dates,
              exams: [
                ...new Map(
                  rows.map((r) => [r.exam_id, { id: r.exam_id, name: r.examination }]),
                ).values(),
              ],
              subjects: [
                ...new Map(
                  rows.map((r) => [r.subject_id, { id: r.subject_id, name: r.subject }]),
                ).values(),
              ],
              ...resultCharts(data),
            };
          },
          true,
        ),
      );
    }),
  );
  child.get(
    '/profile',
    asyncRoute(async (_req, res) => {
      const a: Actor = res.locals.actor;
      res.json(
        await transaction(
          pool,
          a.context,
          async (tx) => {
            const student = (
              await tx.query(`${childSelect} WHERE s.school_id=$1 AND s.id=$2`, [
                a.context.schoolId,
                a.context.parentChildId,
              ])
            ).rows[0];
            if (!student) throw notFound();
            return {
              student,
              parent:
                (
                  await tx.query(
                    "SELECT full_name,email,phone FROM parents WHERE school_id=$1 AND user_id=$2 AND status='ACTIVE'",
                    [a.context.schoolId, a.id],
                  )
                ).rows[0] || null,
            };
          },
          true,
        ),
      );
    }),
  );
  const queries: Record<string, { permission: string; feature?: string; sql: string }> = {
    academics: {
      permission: 'academics.read',
      sql: `SELECT ta.id,ta.subject_id,ta.class_id,s.name AS subject,s.code AS subject_code,te.full_name AS teacher,c.grade,c.section,
      ct.full_name AS class_teacher FROM teacher_class_assignments ta JOIN subjects s ON s.school_id=ta.school_id AND s.id=ta.subject_id
      JOIN teachers te ON te.school_id=ta.school_id AND te.id=ta.teacher_id JOIN classes c ON c.school_id=ta.school_id AND c.id=ta.class_id
      LEFT JOIN teachers ct ON ct.school_id=c.school_id AND ct.id=c.class_teacher_id JOIN schools sc ON sc.id=ta.school_id
      WHERE ta.school_id=$1 AND $2::uuid IS NOT NULL AND ta.retired_at IS NULL AND te.status='ACTIVE'
      AND app.parent_record_access(ta.school_id,'class',ta.class_id) AND ta.starts_on<=(now() AT TIME ZONE sc.timezone)::date
      AND (ta.ends_on IS NULL OR ta.ends_on>=(now() AT TIME ZONE sc.timezone)::date) ORDER BY c.grade,c.section,s.name,ta.id`,
    },
    homework: {
      permission: 'assignments.read',
      feature: 'assignments',
      sql: `SELECT a.id,a.kind,a.title,a.body,a.due_at,s.name AS subject,c.grade,c.section,
      (a.storage_path IS NOT NULL) AS has_attachment FROM assignments a LEFT JOIN subjects s ON s.school_id=a.school_id AND s.id=a.subject_id
      JOIN classes c ON c.school_id=a.school_id AND c.id=a.class_id WHERE a.school_id=$1 AND $2::uuid IS NOT NULL AND a.retired_at IS NULL
      AND app.parent_record_access(a.school_id,'class',a.class_id) ORDER BY a.created_at DESC,a.id`,
    },
    results: {
      permission: 'marks.read',
      sql: `SELECT m.id,ex.name AS examination,ex.assessment_kind,ex.exam_type,ex.starts_on::text AS exam_date,
      s.name AS subject,m.score,ex.max_score,m.remarks FROM marks m JOIN exams ex ON ex.school_id=m.school_id AND ex.id=m.exam_id
      JOIN subjects s ON s.school_id=m.school_id AND s.id=m.subject_id WHERE m.school_id=$1 AND m.student_id=$2
      AND ex.status='PUBLISHED' AND ex.retired_at IS NULL ORDER BY ex.starts_on DESC,ex.name,s.name,m.id`,
    },
    fees: {
      permission: 'fees.read',
      sql: `SELECT f.id,f.fee_type,f.installment_label,f.amount_due,f.amount_paid,
      CASE WHEN f.status='WAIVED' OR f.voided_at IS NOT NULL THEN 0 ELSE f.amount_due-f.amount_paid END AS balance,
      f.currency,f.due_on::text,CASE WHEN f.voided_at IS NOT NULL THEN 'VOIDED' ELSE f.status END AS status,ac.name AS academic_year
      FROM fee_records f LEFT JOIN academic_sessions ac ON ac.school_id=f.school_id AND ac.id=f.academic_session_id
      WHERE f.school_id=$1 AND f.student_id=$2 ORDER BY f.due_on DESC,f.id`,
    },
    payments: {
      permission: 'fees.read',
      sql: `SELECT p.id,p.receipt_no,p.payment_date::text,p.amount,p.currency,p.payment_method,
      CASE WHEN EXISTS(SELECT FROM fee_payment_reversals r WHERE r.school_id=p.school_id AND r.payment_id=p.id) THEN 'REVERSED' ELSE 'PAID' END AS status
      FROM fee_payments p WHERE p.school_id=$1 AND p.student_id=$2 ORDER BY p.payment_date DESC,p.id`,
    },
    reports: {
      permission: 'reports.export',
      sql: `SELECT r.id,r.kind,r.status,r.created_at,coalesce(r.parameters->>'format','PDF') AS format
      FROM report_documents r WHERE r.school_id=$1 AND r.student_id=$2 AND r.requested_by=app.user_id()
      AND (r.status<>'COMPLETED' OR (r.authorization_version=(SELECT access_version FROM schools WHERE id=$1)
      AND r.authorization_scope=app.report_scope_fingerprint(app.user_id()) AND r.authorization_role='parent')) ORDER BY r.created_at DESC,r.id`,
    },
    announcements: {
      permission: 'announcements.read',
      sql: `SELECT a.id,a.title,a.body,a.published_at,c.grade,c.section FROM announcements a
      LEFT JOIN classes c ON c.school_id=a.school_id AND c.id=a.class_id WHERE a.school_id=$1 AND $2::uuid IS NOT NULL
      AND a.retired_at IS NULL AND a.published_at<=now() AND a.audience IN ('SCHOOL','CLASS','PARENTS')
      AND (a.class_id IS NULL OR app.parent_record_access(a.school_id,'class',a.class_id)) ORDER BY a.published_at DESC,a.id`,
    },
    notifications: {
      permission: 'notifications.read',
      sql: `SELECT o.id,o.kind,o.created_at,
      o.payload->>'title' AS title,o.payload->>'body' AS body,o.payload->>'fee_type' AS fee_type,
      o.payload->>'attendance_status' AS attendance_status,o.payload->>'event_time' AS event_time
      FROM notification_outbox o WHERE o.school_id=$1 AND (o.student_id IS NULL OR o.student_id=$2)
      AND app.parent_record_access(o.school_id,'notice',o.id)
      AND (o.payload->>'class_id' IS NULL OR app.parent_record_access(o.school_id,'class',(o.payload->>'class_id')::uuid))
      ORDER BY o.created_at DESC,o.id`,
    },
    corrections: {
      permission: 'attendance.read',
      sql: `SELECT c.id,d.attendance_date::text,c.requested_status,c.reason,c.status,c.requested_at,c.decided_at
      FROM attendance_corrections c JOIN daily_attendance d ON d.school_id=c.school_id AND d.id=c.daily_attendance_id
      WHERE c.school_id=$1 AND d.student_id=$2 AND c.requested_by=app.user_id() ORDER BY c.requested_at DESC,c.id`,
    },
  };
  for (const [section, q] of Object.entries(queries))
    child.get(
      '/' + section,
      asyncRoute(async (req, res) => {
        const a: Actor = res.locals.actor;
        if (!a.active!.permissions.includes(q.permission))
          throw new ApiError(403, 'FORBIDDEN', 'Section unavailable.');
        if (q.feature && !a.features[q.feature])
          throw new ApiError(
            403,
            'FEATURE_UNAVAILABLE',
            'This school plan does not include this section.',
          );
        res.json(
          await transaction(
            pool,
            a.context,
            (tx) => paged(tx, q.sql, [a.context.schoolId, a.context.parentChildId], req.query),
            true,
          ),
        );
      }),
    );
  r.use('/children/:childId', child);
  return r;
}
