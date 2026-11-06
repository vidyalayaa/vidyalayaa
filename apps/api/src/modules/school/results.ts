import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import {
  resultPolicySchema,
  uuid,
  type SchoolResultAnalytics,
  type StudentExamResult,
} from '@vidyalayaa/contracts';
import { audit, transaction, type Tx } from '../../lib/db.js';
import { asyncRoute, notFound } from '../../lib/errors.js';
import { paged } from '../../lib/pagination.js';
import { permission, schoolRoles, type Actor } from '../../middleware/auth.js';
import {
  gradeFor,
  performanceHistory,
  resultDistribution,
  resultExams,
  resultRosterQuery,
  resultSchool,
  resultScores,
  resultStatus,
  resultSubjects,
  standings,
  subjectPerformance,
  summarize,
  topResults,
} from './result-analytics.js';

const filters = z
  .object({
    session_id: uuid,
    cohort_id: uuid,
    grade: z.string().trim().min(1).max(500).optional(),
    class_id: uuid.optional(),
  })
  .strict();

export function resultsRouter(
  pool: pg.Pool,
  requireWrite: (tx: Tx, actor: Actor) => Promise<void>,
) {
  const router = Router();
  // School-wide projections are separate from the scoped teacher and family result routes.
  router.use(schoolRoles('school_admin', 'principal'), permission('marks.read'));

  router.get(
    '/examinations',
    asyncRoute(async (req, res) => {
      const a = res.locals.actor;
      const { session_id } = z.object({ session_id: uuid }).strict().parse(req.query);
      res.json(
        await transaction(
          pool,
          a.context,
          async (tx) => ({
            data: await resultExams(tx, a.context.schoolId, session_id),
          }),
          true,
        ),
      );
    }),
  );

  router.get(
    '/exams/:id/students',
    asyncRoute(async (req, res) => {
      const a = res.locals.actor;
      const exam = uuid.parse(req.params.id);
      const search = z.string().max(120).default('').parse(req.query.search);
      const school = a.context.schoolId;
      res.json(
        await transaction(
          pool,
          a.context,
          async (tx) => {
            const exists = await tx.query(
              'SELECT id FROM exams WHERE school_id=$1 AND id=$2 AND retired_at IS NULL',
              [school, exam],
            );
            if (!exists.rowCount) throw notFound();
            return paged(
              tx,
              resultRosterQuery(),
              [school, [exam], `%${search.replace(/[\\%_]/g, '\\$&')}%`],
              req.query,
            );
          },
          true,
          'repeatable read',
        ),
      );
    }),
  );

  router.get(
    '/exams/:id/students/:student',
    asyncRoute(async (req, res) => {
      const a = res.locals.actor;
      const id = uuid.parse(req.params.id);
      const student = uuid.parse(req.params.student);
      const school = a.context.schoolId;
      const data: StudentExamResult = await transaction(
        pool,
        a.context,
        async (tx) => {
          const session = (
            await tx.query<{ session_id: string }>(
              `SELECT c.academic_session_id AS session_id FROM exams ex
         JOIN classes c ON (c.school_id,c.id)=(ex.school_id,ex.class_id)
         WHERE ex.school_id=$1 AND ex.id=$2 AND ex.retired_at IS NULL`,
              [school, id],
            )
          ).rows[0];
          if (!session) throw notFound();
          const exams = await resultExams(tx, school, session.session_id);
          const exam = exams.find((item) => item.id === id);
          if (!exam) throw notFound();
          const group = exams.filter((item) => item.cohort_id === exam.cohort_id);
          const entries = standings(
            await resultScores(
              tx,
              school,
              group.map((item) => item.id),
            ),
            group,
          );
          const result = entries.find(
            ({ row }) => row.exam_id === id && row.student_id === student,
          );
          if (!result) throw notFound();
          const { name, policy } = await resultSchool(tx, school);
          const subjects = await resultSubjects(tx, school, id, student);
          return {
            school_name: name,
            exam,
            student: result.standing,
            status: resultStatus(result.row, policy),
            grade:
              result.row.count === result.row.expected
                ? gradeFor(policy, result.row.percentage)
                : null,
            recorded_maximum: result.row.recorded_maximum,
            subjects: subjects.map((subject) => ({
              ...subject,
              grade: gradeFor(policy, subject.percentage),
            })),
          };
        },
        true,
        'repeatable read',
      );
      res.json(data);
    }),
  );

  router.get(
    '/analytics',
    asyncRoute(async (req, res) => {
      const a = res.locals.actor;
      const query = filters.parse(req.query);
      const school = a.context.schoolId;
      const data: SchoolResultAnalytics = await transaction(
        pool,
        a.context,
        async (tx) => {
          const all = await resultExams(tx, school, query.session_id);
          const cohort = all.filter((exam) => exam.cohort_id === query.cohort_id);
          const visible = cohort.filter(
            (exam) =>
              (!query.grade || exam.grade === query.grade) &&
              (!query.class_id || exam.class_id === query.class_id),
          );
          if (!visible.length) throw notFound();
          const entries = standings(
            await resultScores(
              tx,
              school,
              cohort.map((exam) => exam.id),
            ),
            cohort,
          );
          const ids = new Set(visible.map((exam) => exam.id));
          const selected = entries.filter(({ row }) => ids.has(row.exam_id));
          const { policy } = await resultSchool(tx, school);
          const section = query.class_id ? visible[0] : undefined;
          return {
            classes: summarize(visible, selected, policy),
            school_toppers: topResults(entries, 'school_position').filter((row) =>
              ids.has(row.exam_id),
            ),
            subjects: await subjectPerformance(tx, school, [...ids]),
            distribution: resultDistribution(selected),
            ...(await performanceHistory(
              tx,
              school,
              query.session_id,
              cohort[0].assessment_kind,
              cohort[0].subject_name,
              section?.grade || query.grade,
              section?.section,
            )),
            pass_percentage: policy.pass_percentage,
          };
        },
        true,
        'repeatable read',
      );
      res.json(data);
    }),
  );

  router.get(
    '/policy',
    asyncRoute(async (_req, res) => {
      const a = res.locals.actor;
      const result = await transaction(
        pool,
        a.context,
        (tx) => resultSchool(tx, a.context.schoolId),
        true,
      );
      res.json(result.policy);
    }),
  );
  router.put(
    '/policy',
    schoolRoles('school_admin'),
    permission('school.manage'),
    asyncRoute(async (req, res) => {
      const a = res.locals.actor;
      const body = resultPolicySchema.parse(req.body);
      await transaction(pool, a.context, async (tx) => {
        await requireWrite(tx, a);
        await tx.query(
          "UPDATE schools SET settings=jsonb_set(settings,'{result_policy}',$2::jsonb,true) WHERE id=$1",
          [a.context.schoolId, body],
        );
        await audit(
          tx,
          a.context.schoolId,
          a.id,
          'results.policy.updated',
          'schools',
          a.context.schoolId,
        );
      });
      res.json(body);
    }),
  );
  return router;
}
