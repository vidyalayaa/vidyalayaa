import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { uuid, classSubjectSchema } from '@vidyalayaa/contracts';
import { transaction, audit, type Tx } from '../../lib/db.js';
import { paged } from '../../lib/pagination.js';
import { asyncRoute, ApiError, notFound } from '../../lib/errors.js';
import { permission, schoolRoles, type Actor } from '../../middleware/auth.js';
import { resourceSelect, validateBusiness } from './resources.js';

// One definition for the section badge and current-enrollment list. Historical
// and future enrollments remain editable in the explicitly selected All view.
const currentEnrollment = `e.status='ACTIVE' AND s.status='ACTIVE'
 AND e.starts_on<=(now() AT TIME ZONE (SELECT timezone FROM schools WHERE id=e.school_id))::date
 AND (e.ends_on IS NULL OR e.ends_on>=(now() AT TIME ZONE (SELECT timezone FROM schools WHERE id=e.school_id))::date)`;
// Existing subjects are selectable only within their configured section. Legacy
// catalogue records with no teaching relationship can be assigned for the first time.
const subjectChoice = `(EXISTS(SELECT FROM teacher_class_assignments ta WHERE ta.school_id=sub.school_id AND ta.subject_id=sub.id AND ta.class_id=$2)
 OR NOT EXISTS(SELECT FROM teacher_class_assignments ta WHERE ta.school_id=sub.school_id AND ta.subject_id=sub.id))`;

async function section(tx: Tx, a: Actor, id: string) {
  if (
    !(
      await tx.query('SELECT id FROM classes WHERE school_id=$1 AND id=$2 AND retired_at IS NULL', [
        a.context.schoolId,
        id,
      ])
    ).rowCount
  )
    throw notFound();
}

interface AcademicWriteControls {
  requireWrite: (tx: Tx, a: Actor, feature?: string) => Promise<void>;
  withIdempotency: <T>(
    tx: Tx,
    a: Actor,
    key: string | undefined,
    body: unknown,
    fn: () => Promise<T>,
  ) => Promise<T>;
}
export function academicsRouter(pool: pg.Pool, writes: AcademicWriteControls) {
  const r = Router();
  const adminOnly = schoolRoles('school_admin');
  const academicsReaders = schoolRoles('school_admin', 'principal');
  r.use(permission('academics.read'), permission('students.read'), permission('teachers.read'));
  r.post(
    '/classes/:id/subjects',
    adminOnly,
    asyncRoute(async (req, res) => {
      const a: Actor = res.locals.actor,
        id = uuid.parse(req.params.id),
        b = classSubjectSchema.parse(req.body);
      if (!['academics.write', 'teachers.write'].every((p) => a.active!.permissions.includes(p)))
        throw new ApiError(
          403,
          'FORBIDDEN',
          'Subject and teacher assignment management permissions are required.',
        );
      const result = await transaction(pool, a.context, async (tx) => {
        await writes.requireWrite(tx, a);
        const classroom = (
          await tx.query(
            'SELECT id FROM classes WHERE school_id=$1 AND id=$2 AND retired_at IS NULL FOR SHARE',
            [a.context.schoolId, id],
          )
        ).rows[0];
        if (!classroom) throw notFound();
        return writes.withIdempotency(
          tx,
          a,
          req.header('Idempotency-Key'),
          { operation: 'academics.subject_assignment', class_id: id, ...b },
          async () => {
            // The subject and its required teacher assignment commit together.
            for (const name of ['subjects', 'teacher_class_assignments'])
              await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
                `${a.context.schoolId}:${name}`,
              ]);
            let subject: Record<string, unknown>;
            if (b.subject) {
              subject = (
                await tx.query(
                  'INSERT INTO subjects(school_id,code,name) VALUES($1,$2,$3) RETURNING *',
                  [a.context.schoolId, b.subject.code, b.subject.name],
                )
              ).rows[0];
              await audit(
                tx,
                a.context.schoolId,
                a.id,
                'subjects.create',
                'subjects',
                String(subject.id),
              );
            } else {
              subject = (
                await tx.query(
                  `SELECT sub.*,${subjectChoice} AS class_scoped FROM subjects sub WHERE sub.school_id=$1 AND sub.id=$3 AND sub.retired_at IS NULL FOR SHARE`,
                  [a.context.schoolId, id, b.subject_id],
                )
              ).rows[0];
              if (!subject) throw notFound();
              if (!subject.class_scoped)
                throw new ApiError(
                  422,
                  'CLASS_SUBJECT_REQUIRED',
                  'Choose a subject created or configured for this class and section, or add a new class subject.',
                );
              delete subject.class_scoped;
            }
            const assignment = {
              class_id: id,
              subject_id: subject.id,
              teacher_id: b.teacher_id,
              starts_on: b.starts_on,
              ends_on: b.ends_on || null,
            };
            await validateBusiness(tx, a, 'teacher_class_assignments', assignment, false);
            const assigned = (
              await tx.query(
                'INSERT INTO teacher_class_assignments(school_id,class_id,subject_id,teacher_id,starts_on,ends_on) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
                [a.context.schoolId, id, subject.id, b.teacher_id, b.starts_on, b.ends_on || null],
              )
            ).rows[0];
            await audit(
              tx,
              a.context.schoolId,
              a.id,
              'teacher_class_assignments.create',
              'teacher_class_assignments',
              assigned.id,
            );
            return { subject, assignment: assigned };
          },
        );
      });
      res.status(201).json(result);
    }),
  );
  r.get(
    '/classes/:id/unconfigured-assignments',
    academicsReaders,
    asyncRoute(async (req, res) => {
      const a: Actor = res.locals.actor,
        id = uuid.parse(req.params.id);
      res.json(
        await transaction(
          pool,
          a.context,
          async (tx) => {
            await section(tx, a, id);
            return paged(
              tx,
              `SELECT ${resourceSelect('teacher_class_assignments')} FROM teacher_class_assignments t
       WHERE t.school_id=$1 AND t.class_id=$2 AND t.subject_id IS NULL AND t.retired_at IS NULL ORDER BY t.starts_on,t.id`,
              [a.context.schoolId, id],
              req.query,
            );
          },
          true,
        ),
      );
    }),
  );
  r.get(
    '/classes',
    academicsReaders,
    asyncRoute(async (req, res) => {
      const a: Actor = res.locals.actor;
      const q = z.object({ session_id: uuid.optional() }).parse(req.query);
      res.json(
        await transaction(
          pool,
          a.context,
          async (tx) => ({
            ...(await paged(
              tx,
              `SELECT ${resourceSelect('classes')},
       ct.status AS class_teacher_status,
       roster.student_count,roster.male_count,roster.female_count,roster.other_count,roster.unspecified_count,
       (SELECT count(DISTINCT ta.subject_id)::int FROM teacher_class_assignments ta JOIN subjects sub ON sub.school_id=ta.school_id AND sub.id=ta.subject_id WHERE ta.school_id=t.school_id AND ta.class_id=t.id AND ta.retired_at IS NULL AND sub.retired_at IS NULL) AS subject_count,
       (SELECT count(*)::int FROM teacher_class_assignments ta WHERE ta.school_id=t.school_id AND ta.class_id=t.id AND ta.retired_at IS NULL) AS assignment_count,
       (SELECT count(*)::int FROM teacher_class_assignments ta WHERE ta.school_id=t.school_id AND ta.class_id=t.id AND ta.retired_at IS NULL AND ta.subject_id IS NULL) AS legacy_assignment_count
       FROM classes t LEFT JOIN teachers ct ON ct.school_id=t.school_id AND ct.id=t.class_teacher_id
       CROSS JOIN LATERAL (
         SELECT count(DISTINCT e.student_id)::int AS student_count,
           count(DISTINCT e.student_id) FILTER(WHERE s.gender='MALE')::int AS male_count,
           count(DISTINCT e.student_id) FILTER(WHERE s.gender='FEMALE')::int AS female_count,
           count(DISTINCT e.student_id) FILTER(WHERE s.gender='OTHER')::int AS other_count,
           count(DISTINCT e.student_id) FILTER(WHERE s.gender='NOT_SPECIFIED')::int AS unspecified_count
         FROM enrollments e JOIN students s ON s.school_id=e.school_id AND s.id=e.student_id
         WHERE e.school_id=t.school_id AND e.class_id=t.id AND ${currentEnrollment}
       ) roster
       WHERE t.school_id=$1 AND t.retired_at IS NULL AND ($2::uuid IS NULL OR t.academic_session_id=$2)
       ORDER BY t.academic_session_id,t.grade,t.section,t.id`,
              [a.context.schoolId, q.session_id || null],
              req.query,
            )),
            sessions: (
              await tx.query(
                'SELECT id,name,is_current,starts_on,ends_on,closed_at FROM academic_sessions WHERE school_id=$1 AND retired_at IS NULL ORDER BY starts_on DESC,id',
                [a.context.schoolId],
              )
            ).rows,
          }),
          true,
        ),
      );
    }),
  );
  r.get(
    '/classes/:id/subject-choices',
    adminOnly,
    asyncRoute(async (req, res) => {
      const a: Actor = res.locals.actor,
        id = uuid.parse(req.params.id);
      const search = z.string().max(120).default('').parse(req.query.search);
      res.json(
        await transaction(
          pool,
          a.context,
          async (tx) => {
            await section(tx, a, id);
            return paged(
              tx,
              `SELECT sub.* FROM subjects sub WHERE sub.school_id=$1 AND sub.retired_at IS NULL AND ${subjectChoice}
       AND concat_ws(' ',sub.name,sub.code) ILIKE $3 ORDER BY sub.name,sub.id`,
              [a.context.schoolId, id, `%${search.replace(/[\\%_]/g, '\\$&')}%`],
              req.query,
            );
          },
          true,
        ),
      );
    }),
  );
  r.get(
    '/classes/:id/subjects',
    academicsReaders,
    asyncRoute(async (req, res) => {
      const a: Actor = res.locals.actor,
        id = uuid.parse(req.params.id);
      res.json(
        await transaction(
          pool,
          a.context,
          async (tx) => {
            await section(tx, a, id);
            return paged(
              tx,
              `SELECT sub.*,
       (SELECT coalesce(jsonb_agg(jsonb_build_object(
         'id',ta.id,'teacher_id',ta.teacher_id,'class_id',ta.class_id,'subject_id',ta.subject_id,
         'teacher_label',te.full_name,'staff_code',te.staff_code,'teacher_status',te.status,
         'starts_on',ta.starts_on,'ends_on',ta.ends_on,
         'is_current',te.status='ACTIVE' AND ta.starts_on<=(now() AT TIME ZONE sc.timezone)::date AND (ta.ends_on IS NULL OR ta.ends_on>=(now() AT TIME ZONE sc.timezone)::date)) ORDER BY te.full_name,ta.id),'[]'::jsonb)
        FROM teacher_class_assignments ta JOIN teachers te ON te.school_id=ta.school_id AND te.id=ta.teacher_id JOIN schools sc ON sc.id=ta.school_id
        WHERE ta.school_id=sub.school_id AND ta.subject_id=sub.id AND ta.class_id=$2 AND ta.retired_at IS NULL) AS teachers
       FROM subjects sub WHERE sub.school_id=$1 AND sub.retired_at IS NULL
       AND EXISTS(SELECT FROM teacher_class_assignments ta WHERE ta.school_id=sub.school_id AND ta.subject_id=sub.id AND ta.class_id=$2 AND ta.retired_at IS NULL)
       ORDER BY sub.name,sub.id`,
              [a.context.schoolId, id],
              req.query,
            );
          },
          true,
        ),
      );
    }),
  );
  r.get(
    '/classes/:id/enrollments',
    adminOnly,
    asyncRoute(async (req, res) => {
      const a: Actor = res.locals.actor,
        id = uuid.parse(req.params.id);
      const q = z.object({ view: z.enum(['current', 'all']).default('current') }).parse(req.query);
      res.json(
        await transaction(
          pool,
          a.context,
          async (tx) => {
            await section(tx, a, id);
            return paged(
              tx,
              `SELECT e.*,s.student_code,concat_ws(' ',s.first_name,s.last_name) AS student_label,s.status AS student_status
       FROM enrollments e JOIN students s ON s.school_id=e.school_id AND s.id=e.student_id
       WHERE e.school_id=$1 AND e.class_id=$2 ${q.view === 'current' ? `AND ${currentEnrollment}` : ''}
       ORDER BY s.student_code,e.starts_on DESC,e.id`,
              [a.context.schoolId, id],
              req.query,
            );
          },
          true,
        ),
      );
    }),
  );
  return r;
}
