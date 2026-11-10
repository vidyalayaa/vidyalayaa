import {
  notificationPrivacySchema,
  reconciliationRequestSchema,
  retirementSchema,
  staffDetailFields,
  staffDetailsSchema,
  type StaffDetails,
} from '@vidyalayaa/contracts';
import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { resourceSchemas, uuid } from '@vidyalayaa/contracts';
import { asyncRoute, ApiError, notFound } from '../../lib/errors.js';
import { permission } from '../../middleware/auth.js';
import { transaction, audit } from '../../lib/db.js';
import { paged } from '../../lib/pagination.js';
import {
  studentScope,
  resourceScope,
  definitions,
  validateBusiness,
  assertStudent,
} from './resources.js';
import { requireWrite, withIdempotency } from './router.js';
import { scheduleAnnouncement } from './announcements.js';
import { savePersonDetails } from './person-profile-details.js';

export const retirementResources = [
  'academic_sessions',
  'classes',
  'subjects',
  'exams',
  'assignments',
  'timetable_entries',
  'school_holidays',
  'announcements',
  'teacher_class_assignments',
] as const;
export function workflowsRouter(pool: pg.Pool) {
  const r = Router();
  r.post(
    '/notifications/:id/retry',
    permission('notifications.manage'),
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        id = uuid.parse(req.params.id),
        b = reconciliationRequestSchema.parse(req.body);
      await transaction(pool, a.context, async (tx) => {
        await requireWrite(tx, a);
        await tx.query('SELECT app.retry_notification($1,$2)', [id, b.reason]);
      });
      res.status(202).json({ status: 'PENDING' });
    }),
  );
  r.get(
    '/profile/preferences',
    permission('notifications.preferences'),
    asyncRoute(async (_req, res) => {
      const a = res.locals.actor;
      res.json(
        await transaction(
          pool,
          a.context,
          async (tx) =>
            (
              await tx.query(
                "SELECT no_names_on_lock_screen FROM parents WHERE school_id=$1 AND user_id=$2 AND status='ACTIVE'",
                [a.context.schoolId, a.id],
              )
            ).rows[0] || { no_names_on_lock_screen: true },
          true,
        ),
      );
    }),
  );
  r.put(
    '/profile/preferences',
    permission('notifications.preferences'),
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        b = notificationPrivacySchema.parse(req.body);
      await transaction(pool, a.context, async (tx) => {
        const row = await tx.query(
          "UPDATE parents SET no_names_on_lock_screen=$3 WHERE school_id=$1 AND user_id=$2 AND status='ACTIVE' RETURNING id",
          [a.context.schoolId, a.id, b.no_names_on_lock_screen],
        );
        if (!row.rowCount) throw notFound();
        await audit(
          tx,
          a.context.schoolId,
          a.id,
          'notification.privacy.updated',
          'parents',
          row.rows[0].id,
        );
      });
      res.json(b);
    }),
  );
  r.get(
    '/usage',
    permission('subscription.read'),
    asyncRoute(async (req, res) => {
      const a = res.locals.actor;
      res.json(
        await transaction(
          pool,
          a.context,
          (tx) =>
            paged(
              tx,
              'SELECT on_date,active_students,devices,notifications_sent,recorded_at FROM school_usage_snapshots WHERE school_id=$1 ORDER BY on_date DESC',
              [a.context.schoolId],
              req.query,
            ),
          true,
        ),
      );
    }),
  );
  r.get(
    '/organization/campuses',
    permission('subscription.read'),
    asyncRoute(async (_req, res) => {
      const a = res.locals.actor;
      res.json({
        data: await transaction(
          pool,
          a.context,
          async (tx) => (await tx.query('SELECT * FROM app.authorized_campuses()')).rows,
          true,
        ),
      });
    }),
  );
  r.get(
    '/analytics',
    permission('marks.read'),
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        q = z.object({ student_id: uuid.optional() }).parse(req.query);
      res.json(
        await transaction(
          pool,
          a.context,
          async (tx) => {
            if (q.student_id) await assertStudent(tx, a, q.student_id);
            const academics = (
              await tx.query(
                `SELECT c.grade,c.section,sub.name AS subject,count(*)::int AS assessments,count(DISTINCT t.student_id)::int AS students,round(100*sum(t.score)/nullif(sum(ex.max_score),0),2) AS percentage FROM marks t JOIN exams ex ON ex.school_id=t.school_id AND ex.id=t.exam_id JOIN classes c ON c.school_id=ex.school_id AND c.id=ex.class_id JOIN subjects sub ON sub.school_id=t.school_id AND sub.id=t.subject_id WHERE t.school_id=$1 AND ex.status='PUBLISHED' AND ex.retired_at IS NULL AND ($3::uuid IS NULL OR t.student_id=$3) AND ${resourceScope('marks', a)} GROUP BY c.grade,c.section,sub.name ORDER BY c.grade,c.section,sub.name`,
                [a.context.schoolId, a.id, q.student_id || null],
              )
            ).rows;
            const attendance = (
              await tx.query(
                `SELECT date_trunc('month',t.attendance_date)::date::text AS month,count(*)::int AS records,count(*) FILTER(WHERE t.attendance_status IN ('PRESENT','LATE','HALF_DAY'))::int AS present,count(*) FILTER(WHERE t.attendance_status='ABSENT')::int AS absent FROM daily_attendance t WHERE t.school_id=$1 AND t.attendance_date>=current_date-180 AND ($3::uuid IS NULL OR t.student_id=$3) AND ${studentScope(a, 't.student_id', '$2')} GROUP BY 1 ORDER BY 1`,
                [a.context.schoolId, a.id, q.student_id || null],
              )
            ).rows;
            return { academics, attendance };
          },
          true,
        ),
      );
    }),
  );
  r.get(
    '/attendance/events',
    permission('attendance.read'),
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        q = z
          .object({
            student_id: uuid.optional(),
            date: z
              .string()
              .regex(/^\d{4}-\d{2}-\d{2}$/)
              .optional(),
            review: z.enum(['1']).optional(),
          })
          .parse(req.query);
      if (q.review && !a.active!.permissions.includes('attendance.correct_approve'))
        throw new ApiError(403, 'FORBIDDEN', 'School attendance review permission required.');
      res.json(
        await transaction(
          pool,
          a.context,
          (tx) =>
            paged(
              tx,
              `SELECT t.id,t.student_id,s.first_name,s.last_name,s.student_code,t.event_ts,t.effective_ts,t.location_type,t.timestamp_trust,t.outcome,t.status,d.name AS device_name,t.processed_at FROM attendance_events t LEFT JOIN students s ON s.school_id=t.school_id AND s.id=t.student_id JOIN devices d ON d.school_id=t.school_id AND d.id=t.device_id WHERE t.school_id=$1 AND (${studentScope(a, 't.student_id', '$2')}) AND ($3::uuid IS NULL OR t.student_id=$3) AND ($4::date IS NULL OR (t.effective_ts AT TIME ZONE (SELECT timezone FROM schools WHERE id=t.school_id))::date=$4) ${q.review ? "AND t.outcome IN ('QUARANTINED_TIMESTAMP','STORED_PENDING_RULES','REJECTED_UNKNOWN_CARD','REJECTED_CARD_BLOCKED')" : ''} ORDER BY t.effective_ts DESC,t.id DESC`,
              [a.context.schoolId, a.id, q.student_id || null, q.date || null],
              req.query,
            ),
          true,
        ),
      );
    }),
  );
  r.post(
    '/attendance/events/:id/reconcile',
    permission('attendance.correct_approve'),
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        id = uuid.parse(req.params.id),
        b = reconciliationRequestSchema.parse(req.body);
      const result = await transaction(pool, a.context, async (tx) => {
        await requireWrite(tx, a);
        const e = (
          await tx.query(
            "SELECT id FROM attendance_events WHERE school_id=$1 AND id=$2 AND outcome IN ('QUARANTINED_TIMESTAMP','STORED_PENDING_RULES')",
            [a.context.schoolId, id],
          )
        ).rows[0];
        if (!e) throw notFound();
        const row = (
          await tx.query(
            'INSERT INTO attendance_reconciliation_requests(school_id,event_id,requested_by,reason) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING *',
            [a.context.schoolId, id, a.id, b.reason],
          )
        ).rows[0];
        if (!row)
          throw new ApiError(409, 'REVIEW_PENDING', 'This event already has a pending review.');
        await audit(
          tx,
          a.context.schoolId,
          a.id,
          'attendance.reconcile_requested',
          'attendance_events',
          id,
        );
        return row;
      });
      res.status(202).json(result);
    }),
  );
  r.get(
    '/attendance/reviews',
    permission('attendance.correct_approve'),
    asyncRoute(async (req, res) => {
      const a = res.locals.actor;
      res.json(
        await transaction(
          pool,
          a.context,
          (tx) =>
            paged(
              tx,
              'SELECT id,event_id,reason,status,result_code,created_at,updated_at FROM attendance_reconciliation_requests WHERE school_id=$1 ORDER BY created_at DESC,id DESC',
              [a.context.schoolId],
              req.query,
            ),
          true,
        ),
      );
    }),
  );
  r.get(
    '/profile/family',
    permission('students.read'),
    asyncRoute(async (_req, res) => {
      const a = res.locals.actor;
      if (!['parent', 'student'].includes(a.active!.role))
        throw new ApiError(403, 'FORBIDDEN', 'Family account required.');
      res.json(
        await transaction(
          pool,
          a.context,
          async (tx) => ({
            profile:
              a.active!.role === 'parent'
                ? (
                    await tx.query(
                      "SELECT id,full_name,email,phone FROM parents WHERE school_id=$1 AND user_id=$2 AND status='ACTIVE'",
                      [a.context.schoolId, a.id],
                    )
                  ).rows[0] || null
                : null,
            children: (
              await tx.query(
                `SELECT t.id,t.student_code,t.first_name,t.last_name,t.date_of_birth FROM students t WHERE t.school_id=$1 AND ${studentScope(a, 't.id', '$2')} ORDER BY t.first_name,t.id`,
                [a.context.schoolId, a.id],
              )
            ).rows,
          }),
          true,
        ),
      );
    }),
  );
  r.post(
    '/resources/:resource/:id/retire',
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        name = z.enum(retirementResources).parse(req.params.resource),
        id = uuid.parse(req.params.id),
        b = reconciliationRequestSchema.parse(req.body),
        d = definitions[name];
      if (!d.write || !a.active!.permissions.includes(d.write))
        throw new ApiError(403, 'FORBIDDEN', 'Record management permission required.');
      await transaction(pool, a.context, async (tx) => {
        await requireWrite(tx, a, d.feature);
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `${a.context.schoolId}:${name}`,
        ]);
        const old = (
          await tx.query(
            `SELECT t.* FROM ${name} t WHERE t.school_id=$1 AND t.id=$3 AND ${resourceScope(name, a)} FOR UPDATE`,
            [a.context.schoolId, a.id, id],
          )
        ).rows[0];
        if (!old) throw notFound();
        if (
          name === 'classes' &&
          (
            await tx.query(
              "SELECT id FROM enrollments WHERE school_id=$1 AND class_id=$2 AND status='ACTIVE' LIMIT 1",
              [a.context.schoolId, id],
            )
          ).rowCount
        )
          throw new ApiError(
            409,
            'ACTIVE_ENROLLMENT',
            'End or transfer active enrollments before archiving this class.',
          );
        if (name === 'academic_sessions' && old.is_current)
          throw new ApiError(
            409,
            'CURRENT_SESSION',
            'Select another current academic session before archiving.',
          );
        const row = (
          await tx.query(
            `UPDATE ${name} SET retired_at=now()${name === 'announcements' ? ',published_at=NULL' : ''} WHERE school_id=$1 AND id=$2 RETURNING *`,
            [a.context.schoolId, id],
          )
        ).rows[0];
        if (name === 'announcements') await scheduleAnnouncement(tx, a.context.schoolId, row);
        await tx.query(
          "INSERT INTO audit_logs(school_id,actor_type,actor_id,action,entity_type,entity_id,after) VALUES($1,'USER',$2,'record.retired',$3,$4,$5)",
          [a.context.schoolId, a.id, name, id, { reason: b.reason }],
        );
      });
      res.status(204).end();
    }),
  );
  r.post(
    '/imports/:resource',
    permission('users.manage'),
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        name = z
          .enum(['students', 'parents', 'teachers', 'student_parents', 'teacher_class_assignments'])
          .parse(req.params.resource),
        b = z
          .object({
            rows: z.array(z.record(z.unknown())).min(1).max(500),
            validate_only: z.boolean().default(true),
          })
          .strict()
          .parse(req.body),
        d = definitions[name];
      if (!a.active!.permissions.includes(d.write!))
        throw new ApiError(403, 'FORBIDDEN', 'Import permission required.');
      if (name === 'teachers' && a.active!.role !== 'school_admin')
        throw new ApiError(403, 'FORBIDDEN', 'School Admin access is required to import staff.');
      const result = await transaction(pool, a.context, async (tx) => {
        await requireWrite(tx, a, d.feature);
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `${a.context.schoolId}:${name}`,
        ]);
        const run = async () => {
          await tx.query('SAVEPOINT import_preview');
          const parsed: { row: Record<string, unknown>; details?: StaffDetails }[] = [],
            errors: { row: number; path: (string | number)[]; message: string }[] = [];
          const insert = async (row: Record<string, unknown>, details?: StaffDetails) => {
            const keys = Object.keys(row);
            const result = await tx.query(
              `INSERT INTO ${name}(school_id,${keys.join(',')}) VALUES($1,${keys.map((_, n) => '$' + (n + 2)).join(',')}) RETURNING id`,
              [a.context.schoolId, ...keys.map((k) => row[k])],
            );
            if (details)
              await savePersonDetails(tx, a.context.schoolId, 'staff', result.rows[0].id, details);
          };
          for (let i = 0; i < b.rows.length; i++) {
            await tx.query('SAVEPOINT validate_import_row');
            try {
              const input = { ...b.rows[i] };
              const staffFields: Record<string, unknown> = {};
              if (name === 'teachers') {
                for (const field of staffDetailFields) {
                  if (field in input) staffFields[field] = input[field];
                  delete input[field];
                }
              }
              const details = Object.keys(staffFields).length
                ? staffDetailsSchema.parse(staffFields)
                : undefined;
              const resolve = async (
                field: string,
                table: string,
                column: string,
                lookup: string,
              ) => {
                if (!input[field]) return;
                const match = (
                  await tx.query(`SELECT id FROM ${table} WHERE school_id=$1 AND ${column}=$2`, [
                    a.context.schoolId,
                    String(input[field]),
                  ])
                ).rows;
                if (match.length !== 1)
                  throw new ApiError(
                    422,
                    'REFERENCE_NOT_UNIQUE',
                    `Choose a unique existing ${field.replaceAll('_', ' ')}.`,
                  );
                input[lookup] = match[0].id;
                delete input[field];
              };
              if (name === 'student_parents') {
                await resolve('student_code', 'students', 'student_code', 'student_id');
                await resolve('parent_email', 'parents', 'email', 'parent_id');
              }
              if (name === 'teacher_class_assignments') {
                await resolve('teacher_code', 'teachers', 'staff_code', 'teacher_id');
                await resolve('subject_code', 'subjects', 'code', 'subject_id');
                if (input.class_grade && input.class_section) {
                  const cl = (
                    await tx.query(
                      'SELECT c.id FROM classes c JOIN academic_sessions ac ON ac.school_id=c.school_id AND ac.id=c.academic_session_id WHERE c.school_id=$1 AND c.grade=$2 AND c.section=$3 AND c.retired_at IS NULL AND ac.is_current',
                      [a.context.schoolId, input.class_grade, input.class_section],
                    )
                  ).rows;
                  if (cl.length !== 1)
                    throw new ApiError(
                      422,
                      'CLASS_NOT_FOUND',
                      'Choose a unique current grade and section.',
                    );
                  input.class_id = cl[0].id;
                  delete input.class_grade;
                  delete input.class_section;
                }
              }
              if (input.account_email) {
                const role =
                  name === 'parents'
                    ? 'parent'
                    : name === 'teachers'
                      ? input.staff_role || 'teacher'
                      : 'student';
                const account = (
                  await tx.query(
                    "SELECT u.id FROM users u JOIN school_memberships m ON m.user_id=u.id JOIN roles r ON r.id=m.role_id WHERE m.school_id=$1 AND m.status='ACTIVE' AND u.status='ACTIVE' AND r.code=$2 AND lower(u.email::text)=lower($3)",
                    [a.context.schoolId, role, String(input.account_email)],
                  )
                ).rows[0];
                if (!account)
                  throw new ApiError(
                    422,
                    'ACCOUNT_NOT_FOUND',
                    'The account must accept an invitation for this school and role first.',
                  );
                input.user_id = account.id;
                delete input.account_email;
              }
              const row = resourceSchemas[name].parse(input) as Record<string, unknown>;
              await validateBusiness(tx, a, name, row, false);
              await insert(row, details);
              parsed.push({ row, details });
            } catch (e) {
              await tx.query('ROLLBACK TO SAVEPOINT validate_import_row');
              if (e instanceof z.ZodError)
                errors.push(
                  ...e.issues.map((issue) => ({
                    row: i + 1,
                    path: issue.path,
                    message: issue.message,
                  })),
                );
              else
                errors.push({
                  row: i + 1,
                  path: [],
                  message:
                    e instanceof ApiError
                      ? e.message
                      : e instanceof Error && e.message === 'PROFILE_CODE_DUPLICATE'
                        ? 'This admission number or employee ID already exists in this school or import.'
                        : 'This row conflicts with existing records.',
                });
            }
            await tx.query('RELEASE SAVEPOINT validate_import_row');
          }
          await tx.query('ROLLBACK TO SAVEPOINT import_preview');
          await tx.query('RELEASE SAVEPOINT import_preview');
          if (errors.length)
            throw new ApiError(
              422,
              'IMPORT_VALIDATION_FAILED',
              'No records were imported.',
              errors,
            );
          if (name === 'students') {
            const active = Number(
              (
                await tx.query(
                  "SELECT count(*) FROM students WHERE school_id=$1 AND status='ACTIVE'",
                  [a.context.schoolId],
                )
              ).rows[0].count,
            );
            if (
              active + parsed.filter((x) => x.row.status === 'ACTIVE').length >
              (a.limits.max_students ?? 0)
            )
              throw new ApiError(
                409,
                'PLAN_LIMIT_REACHED',
                'Import would exceed the active student limit.',
              );
          }
          if (b.validate_only) return { validated: parsed.length, imported: 0 };
          {
            for (const { row, details } of parsed) await insert(row, details);
            await audit(tx, a.context.schoolId, a.id, 'records.imported', name);
            return { validated: parsed.length, imported: parsed.length };
          }
        };
        return b.validate_only
          ? run()
          : withIdempotency(tx, a, req.header('Idempotency-Key'), { name, rows: b.rows }, run);
      });
      res.status(b.validate_only ? 200 : 201).json(result);
    }),
  );
  return r;
}
