import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import {
  attendanceCalendarPeriodSchema,
  attendanceStatuses,
  pageSchema,
  uuid,
  type AttendanceCalendarDay,
  type AttendanceCalendarOptions,
} from '@vidyalayaa/contracts';
import { transaction, type Tx } from '../../lib/db.js';
import { ApiError, asyncRoute, notFound } from '../../lib/errors.js';
import { paged } from '../../lib/pagination.js';
import { permission, type Actor } from '../../middleware/auth.js';
import { localParts } from '../attendance/engine.js';
import { assertClass, assertStudent, studentScope } from './resources.js';

const scopeSchema = z.object({
  academic_session_id: uuid.optional(),
  class_id: uuid.optional(),
  grade: z.string().trim().min(1).max(80).optional(),
  student_id: uuid.optional(),
});
type Filters = z.infer<typeof scopeSchema>;
type Scope = Awaited<ReturnType<typeof resolveScope>>;

async function resolveScope(tx: Tx, a: Actor, filters: Filters) {
  const role = a.active!.role;
  if (!['school_admin', 'principal', 'teacher', 'student', 'parent'].includes(role))
    throw new ApiError(403, 'FORBIDDEN', 'Attendance access required.');
  const family = role === 'student' || role === 'parent';
  const school = a.context.schoolId;
  let student = filters.student_id;
  if (family) {
    if (filters.student_id || filters.class_id || filters.grade)
      throw new ApiError(403, 'FORBIDDEN', 'Use the attendance records for your own workspace.');
    if (role === 'parent') {
      student = a.context.parentChildId;
      if (
        !student ||
        !(await tx.query('SELECT app.parent_student_access($1,$2) AS allowed', [school, student]))
          .rows[0]?.allowed
      )
        throw notFound();
    } else {
      student = (
        await tx.query<{ id: string }>(
          "SELECT id FROM students WHERE school_id=$1 AND user_id=$2 AND status='ACTIVE'",
          [school, a.id],
        )
      ).rows[0]?.id;
      if (!student) throw notFound();
    }
  } else {
    if (student) await assertStudent(tx, a, student);
    if (filters.class_id) await assertClass(tx, a, filters.class_id);
  }
  return { school, student, family };
}

const selection = (alias: 'e' | 'd') =>
  `($6::uuid IS NULL OR ${alias}.academic_session_id=$6)
   AND ($7::uuid IS NULL OR ${alias}.class_id=$7)
   AND ($8::text IS NULL OR c.grade=$8)
   AND ($5::uuid IS NULL OR ${alias}.student_id=$5)`;

const recordsFrom = (a: Actor) => `
 FROM daily_attendance d
 JOIN students t ON t.school_id=d.school_id AND t.id=d.student_id
 LEFT JOIN classes c ON c.school_id=d.school_id AND c.id=d.class_id
 WHERE d.school_id=$1 AND d.attendance_date BETWEEN $3::date AND least($4::date,$9::date)
   AND ${selection('d')} AND ${studentScope(a, 't.id', '$2')}`;

function values(a: Actor, scope: Scope, filters: Filters, from: string, to: string, today: string) {
  return [
    scope.school,
    a.id,
    from,
    to,
    scope.student || null,
    filters.academic_session_id || null,
    filters.class_id || null,
    filters.grade || null,
    today,
  ];
}

export async function readAttendanceCalendar(
  tx: Tx,
  a: Actor,
  scope: Scope,
  filters: Filters,
  from: string,
  to: string,
  today: string,
) {
  // Resolve one enrollment per student and day, then classify the schedule once
  // per class and date. The stored record takes precedence when a student transferred.
  const result = await tx.query<AttendanceCalendarDay>(
    `
 WITH dates AS (
   SELECT $3::date+n AS day FROM generate_series(0,least($4::date,$9::date)-$3::date) n
 ), enrollment_days AS (
   SELECT DISTINCT ON (e.student_id, ds.day) e.student_id, ds.day, e.class_id
   FROM enrollments e
   JOIN students t ON t.school_id=e.school_id AND t.id=e.student_id
   JOIN academic_sessions a ON a.school_id=e.school_id AND a.id=e.academic_session_id
   LEFT JOIN classes c ON c.school_id=e.school_id AND c.id=e.class_id
   JOIN dates ds ON ds.day BETWEEN greatest(e.starts_on,a.starts_on) AND least(e.ends_on,a.ends_on)
   WHERE e.school_id=$1 AND (e.status='ACTIVE' OR e.ends_on IS NOT NULL)
     AND greatest(e.starts_on,a.starts_on)<=least($4::date,$9::date)
     AND least(e.ends_on,a.ends_on)>=$3::date
     AND ${selection('e')} AND ${studentScope(a, 't.id', '$2')}
   ORDER BY e.student_id,ds.day,e.starts_on DESC,e.id
 ), recorded AS (
   SELECT d.student_id,d.attendance_date AS day,d.class_id,d.attendance_status
   ${recordsFrom(a)}
 ), class_days AS (
   SELECT coalesce(r.day,e.day) AS day,coalesce(r.class_id,e.class_id) AS class_id,
    count(*)::int AS roster,
    count(*) FILTER (WHERE r.attendance_status='PRESENT')::int AS present,
    count(*) FILTER (WHERE r.attendance_status='ABSENT')::int AS absent,
    count(*) FILTER (WHERE r.attendance_status='HALF_DAY')::int AS half_day,
    count(*) FILTER (WHERE r.attendance_status='LATE')::int AS late,
    count(*) FILTER (WHERE r.attendance_status='EXCUSED')::int AS excused,
    count(*) FILTER (WHERE r.attendance_status='PENDING')::int AS pending,
    count(*) FILTER (WHERE r.attendance_status IS NULL)::int AS unmarked
   FROM enrollment_days e FULL JOIN recorded r USING(student_id,day)
   GROUP BY 1,2
 ), events AS MATERIALIZED (
   ${
     scope.family
       ? 'SELECT * FROM app.attendance_calendar_holidays($1,$5,$3,least($4::date,$9::date)) WHERE $3::date<=$9::date'
       : `SELECT id,kind,label,on_date,ends_on,target_class_ids FROM school_holidays
         WHERE school_id=$1 AND retired_at IS NULL AND on_date<=$4::date
         AND coalesce(ends_on,on_date)>=$3::date
         AND kind IN ('HOLIDAY','WEEKEND_OVERRIDE','EXAM_DAY','SHORT_DAY')`
   }
 ), scheduled AS (
   SELECT cd.*,h.label AS holiday_name,
    CASE WHEN h.kind='HOLIDAY' THEN 'HOLIDAY'
      WHEN h.kind='WEEKEND_OVERRIDE' THEN 'WORKING'
      WHEN rv.id IS NOT NULL THEN CASE WHEN coalesce(rv.rules->'weekly_off','[]'::jsonb)
        ? (ARRAY['SUN','MON','TUE','WED','THU','FRI','SAT'])[extract(dow FROM cd.day)::int+1]
        THEN 'WEEKLY_OFF' ELSE 'WORKING' END
      WHEN jsonb_typeof(sc.settings->'timetable'->'days')='array' THEN
        CASE WHEN (sc.settings->'timetable'->'days') @> to_jsonb(extract(isodow FROM cd.day)::int)
        THEN 'WORKING' ELSE 'WEEKLY_OFF' END
      WHEN extract(isodow FROM cd.day)=7 THEN 'WEEKLY_OFF' ELSE 'WORKING' END AS schedule,
    (rv.id IS NULL AND jsonb_typeof(sc.settings->'timetable'->'days') IS DISTINCT FROM 'array'
      AND h.kind IS DISTINCT FROM 'WEEKEND_OVERRIDE') AS uses_default
   FROM class_days cd JOIN schools sc ON sc.id=$1
   LEFT JOIN LATERAL (
     SELECT h.kind,h.label FROM events h
     WHERE cd.day BETWEEN h.on_date AND coalesce(h.ends_on,h.on_date)
       AND (cardinality(h.target_class_ids)=0 OR cd.class_id=ANY(h.target_class_ids))
     ORDER BY (cardinality(h.target_class_ids)>0) DESC,
       CASE h.kind WHEN 'HOLIDAY' THEN 0 WHEN 'WEEKEND_OVERRIDE' THEN 1 WHEN 'EXAM_DAY' THEN 2 ELSE 3 END,h.id
     LIMIT 1
   ) h ON true
   LEFT JOIN LATERAL (
     SELECT r.id,r.rules FROM attendance_rule_versions r
     WHERE r.school_id=$1 AND (r.class_id=cd.class_id OR r.class_id IS NULL)
       AND r.day_type=CASE h.kind WHEN 'EXAM_DAY' THEN 'EXAM' WHEN 'SHORT_DAY' THEN 'SHORT_DAY' ELSE 'REGULAR' END
       AND r.effective_from<=cd.day AND (r.effective_to IS NULL OR r.effective_to>cd.day)
     ORDER BY r.class_id NULLS LAST,r.effective_from DESC LIMIT 1
   ) rv ON true
 )
 SELECT day::text AS date,
   coalesce(sum(roster) FILTER (WHERE schedule='WORKING'),0)::int AS working,
   coalesce(sum(roster) FILTER (WHERE schedule='HOLIDAY'),0)::int AS holidays,
   coalesce(sum(roster) FILTER (WHERE schedule='WEEKLY_OFF'),0)::int AS weekly_off,
   ${['present', 'absent', 'half_day', 'late', 'excused', 'pending', 'unmarked']
     .map((key) => `coalesce(sum(${key}) FILTER (WHERE schedule='WORKING'),0)::int AS ${key}`)
     .join(',\n   ')},
   coalesce(array_agg(DISTINCT holiday_name ORDER BY holiday_name)
     FILTER (WHERE schedule='HOLIDAY' AND holiday_name<>''),ARRAY[]::text[]) AS holiday_names,
   bool_or(uses_default AND schedule='WORKING') AS uses_default_schedule
 FROM scheduled GROUP BY day ORDER BY day`,
    values(a, scope, filters, from, to, today),
  );
  return result.rows;
}

export function attendanceCalendarRouter(pool: pg.Pool) {
  const router = Router();
  router.use(permission('attendance.read'));
  router.get(
    '/options',
    asyncRoute(async (_req, res) => {
      const a: Actor = res.locals.actor;
      res.json(
        await transaction(
          pool,
          a.context,
          async (tx): Promise<AttendanceCalendarOptions> => {
            const scope = await resolveScope(tx, a, {});
            const sessions = (
              await tx.query<AttendanceCalendarOptions['sessions'][number]>(
                `
        SELECT ac.id,ac.name,ac.starts_on::text,ac.ends_on::text,ac.is_current
        FROM academic_sessions ac WHERE ac.school_id=$1
          AND ($2::uuid IS NULL OR EXISTS (
            SELECT FROM enrollments e WHERE e.school_id=ac.school_id
              AND e.academic_session_id=ac.id AND e.student_id=$2
          ))
        ORDER BY ac.is_current DESC,ac.starts_on DESC,ac.id`,
                [scope.school, scope.student || null],
              )
            ).rows;
            const classes = scope.family
              ? []
              : (
                  await tx.query<AttendanceCalendarOptions['classes'][number]>(
                    'SELECT id,academic_session_id,grade,section FROM classes WHERE school_id=$1 ORDER BY grade,section,id',
                    [scope.school],
                  )
                ).rows;
            return { sessions, classes };
          },
          true,
        ),
      );
    }),
  );
  router.get(
    '/students',
    asyncRoute(async (req, res) => {
      const a: Actor = res.locals.actor;
      const filters = scopeSchema.parse(req.query);
      const page = pageSchema.parse(req.query);
      res.json(
        await transaction(
          pool,
          a.context,
          async (tx) => {
            const scope = await resolveScope(tx, a, filters);
            if (scope.family)
              throw new ApiError(403, 'FORBIDDEN', 'Student lookup is available to staff.');
            return paged(
              tx,
              `
        SELECT t.id,t.first_name,t.last_name,t.student_code
        FROM students t WHERE t.school_id=$1 AND ${studentScope(a, 't.id', '$2')}
          AND ($3::text IS NULL OR concat_ws(' ',t.first_name,t.last_name,t.student_code) ILIKE $3)
          AND (($4::uuid IS NULL AND $5::uuid IS NULL AND $6::text IS NULL) OR EXISTS (
            SELECT FROM enrollments e JOIN classes c ON c.school_id=e.school_id AND c.id=e.class_id
            WHERE e.school_id=t.school_id AND e.student_id=t.id
              AND ($4::uuid IS NULL OR e.academic_session_id=$4)
              AND ($5::uuid IS NULL OR e.class_id=$5) AND ($6::text IS NULL OR c.grade=$6)
          ))
        ORDER BY t.first_name,t.last_name,t.id`,
              [
                scope.school,
                a.id,
                page.search ? '%' + page.search + '%' : null,
                filters.academic_session_id || null,
                filters.class_id || null,
                filters.grade || null,
              ],
              page,
            );
          },
          true,
        ),
      );
    }),
  );
  router.get(
    '/',
    asyncRoute(async (req, res) => {
      const a: Actor = res.locals.actor;
      const { from, to } = attendanceCalendarPeriodSchema.parse(req.query);
      const filters = scopeSchema.parse(req.query);
      const today = localParts(new Date(), a.active!.timezone).date;
      res.json(
        await transaction(
          pool,
          a.context,
          async (tx) => {
            const scope = await resolveScope(tx, a, filters);
            const days =
              from > today
                ? []
                : await readAttendanceCalendar(tx, a, scope, filters, from, to, today);
            return { today, days };
          },
          true,
        ),
      );
    }),
  );
  router.get(
    '/day',
    asyncRoute(async (req, res) => {
      const a: Actor = res.locals.actor;
      const { date, status } = z
        .object({ date: z.iso.date(), status: z.enum(attendanceStatuses).optional() })
        .parse(req.query);
      const filters = scopeSchema.parse(req.query);
      const page = pageSchema.parse(req.query);
      const today = localParts(new Date(), a.active!.timezone).date;
      res.json(
        await transaction(
          pool,
          a.context,
          async (tx) => {
            const scope = await resolveScope(tx, a, filters);
            const where = `${recordsFrom(a)} AND ($10::text IS NULL OR d.attendance_status=$10)`;
            return paged(
              tx,
              `SELECT d.id,d.student_id,d.class_id,t.first_name,t.last_name,t.student_code,c.grade,c.section,
          d.attendance_status,d.movement_status,d.first_arrival_at,d.last_departure_at ${where}
          ORDER BY t.first_name,t.last_name,d.id`,
              [...values(a, scope, filters, date, date, today), status || null],
              page,
            );
          },
          true,
        ),
      );
    }),
  );
  return router;
}
