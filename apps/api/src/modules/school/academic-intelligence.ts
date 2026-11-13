import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { uuid } from '@vidyalayaa/contracts';
import type { Config } from '../../lib/config.js';
import { audit, transaction, type Tx } from '../../lib/db.js';
import { ApiError, asyncRoute, notFound } from '../../lib/errors.js';
import { permission, type Actor } from '../../middleware/auth.js';
import {
  academicAdviceSchema,
  academicAi,
  academicFacts,
  analysisKey,
  assistantQuestion,
  schoolFacts,
} from './academic-ai.js';
import {
  academicCohort,
  academicProfiles,
  academicSelection,
  individualPerformance,
  publishedMarks,
} from './academic-records.js';
import { resultSchool } from './result-analytics.js';

const individual = z.object({ student_id: uuid.optional(), exam_id: uuid.optional() }).strict();
export const academicFilters = z
  .object({
    session_id: uuid.optional(),
    exam_id: uuid.optional(),
    class_id: uuid.optional(),
    grade: z.string().min(1).max(500).optional(),
    subject_id: uuid.optional(),
    student_id: uuid.optional(),
  })
  .strict();
const family = ['parent', 'student'];
const staff = ['school_admin', 'principal', 'teacher'];

async function learner(tx: Tx, a: Actor, requested: string | undefined) {
  const school = a.context.schoolId;
  if (a.active!.role === 'student') {
    const student = (
      await tx.query<{ id: string }>(
        "SELECT id FROM students WHERE school_id=$1 AND user_id=$2 AND status='ACTIVE'",
        [school, a.id],
      )
    ).rows[0]?.id;
    if (!student || (requested && requested !== student)) throw notFound();
    return student;
  }
  if (requested && (await academicProfiles(tx, school, requested)).length) return requested;
  throw notFound();
}

export async function cohortData(
  tx: Tx,
  school: string,
  filters: z.infer<typeof academicFilters>,
  teacher = false,
) {
  const profiles = await academicProfiles(tx, school, null);
  if (filters.student_id && !profiles.some((profile) => profile.id === filters.student_id))
    throw notFound();
  return academicCohort(
    await publishedMarks(tx, school, null),
    profiles,
    (await resultSchool(tx, school)).policy,
    filters,
    teacher,
  );
}

export function academicIntelligenceRouter(
  pool: pg.Pool,
  config: Config,
  requireWrite: (tx: Tx, actor: Actor) => Promise<void>,
) {
  const r = Router();
  const ai = academicAi(config);
  r.use(permission('marks.read'), (_req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    if (![...family, ...staff].includes(res.locals.actor.active?.role ?? ''))
      return next(notFound());
    next();
  });
  function read(a: Actor, query: z.infer<typeof individual>) {
    return transaction(
      pool,
      a.context,
      async (tx) => {
        const id = await learner(tx, a, query.student_id);
        return individualPerformance(tx, a.context.schoolId, id, query.exam_id, a.active!.role);
      },
      true,
      'repeatable read',
    );
  }
  r.get(
    '/selection',
    asyncRoute(async (req, res) => {
      const a: Actor = res.locals.actor;
      const { student_id } = individual.omit({ exam_id: true }).parse(req.query);
      const school = a.context.schoolId;
      res.json(
        await transaction(
          pool,
          a.context,
          async (tx) => {
            const student =
              family.includes(a.active!.role) || student_id
                ? await learner(tx, a, student_id)
                : null;
            return academicSelection(
              await publishedMarks(tx, school, student),
              await academicProfiles(tx, school, student),
            );
          },
          true,
          'repeatable read',
        ),
      );
    }),
  );
  r.get(
    '/performance',
    asyncRoute(async (req, res) => {
      res.json(await read(res.locals.actor, individual.parse(req.query)));
    }),
  );
  r.get(
    '/cohort',
    asyncRoute(async (req, res) => {
      const a: Actor = res.locals.actor;
      if (!staff.includes(a.active!.role)) throw notFound();
      const filters = academicFilters.parse(req.query);
      res.json(
        await transaction(
          pool,
          a.context,
          (tx) => cohortData(tx, a.context.schoolId, filters, a.active!.role === 'teacher'),
          true,
          'repeatable read',
        ),
      );
    }),
  );
  r.get(
    '/sharing',
    asyncRoute(async (_req, res) => {
      const a: Actor = res.locals.actor;
      if (!['school_admin', 'principal'].includes(a.active!.role)) throw notFound();
      const data = await transaction(
        pool,
        a.context,
        async (tx) =>
          (
            await tx.query<{ share_class_averages: boolean }>(
              "SELECT coalesce(settings->'share_result_class_averages'='true'::jsonb,false) AS share_class_averages FROM schools WHERE id=$1",
              [a.context.schoolId],
            )
          ).rows[0],
        true,
      );
      res.json(data);
    }),
  );
  r.put(
    '/sharing',
    permission('school.manage'),
    asyncRoute(async (req, res) => {
      const a: Actor = res.locals.actor;
      if (a.active!.role !== 'school_admin') throw notFound();
      const body = z.object({ share_class_averages: z.boolean() }).strict().parse(req.body);
      await transaction(pool, a.context, async (tx) => {
        await requireWrite(tx, a);
        await tx.query(
          "UPDATE schools SET settings=jsonb_set(settings,'{share_result_class_averages}',to_jsonb($2::boolean),true) WHERE id=$1",
          [a.context.schoolId, body.share_class_averages],
        );
        await audit(
          tx,
          a.context.schoolId,
          a.id,
          'results.class_average_sharing.updated',
          'schools',
          a.context.schoolId,
        );
      });
      res.json(body);
    }),
  );
  r.post(
    '/cohort/insights',
    asyncRoute(async (req, res) => {
      const a: Actor = res.locals.actor;
      if (!staff.includes(a.active!.role)) throw notFound();
      const filters = academicFilters.parse(req.body);
      const cohort = await transaction(
        pool,
        a.context,
        (tx) => cohortData(tx, a.context.schoolId, filters, a.active!.role === 'teacher'),
        true,
        'repeatable read',
      );
      if (!cohort.appeared)
        throw new ApiError(
          422,
          'INSUFFICIENT_RESULTS',
          'There are no published marks for these filters.',
        );
      const facts = schoolFacts(cohort);
      const output = await ai.school(
        facts,
        analysisKey([a.context.schoolId, a.active!.role, 'cohort', facts]),
      );
      const labels = { C: cohort.classes, S: cohort.subjects, T: cohort.sessions };
      const replace = (value: string) =>
        value.replace(
          /\[([CST])(\d+)\]/g,
          (original, kind: keyof typeof labels, index) =>
            labels[kind][Number(index) - 1]?.name ?? original,
        );
      res.json({ summary: replace(output.summary), insights: output.insights.map(replace) });
    }),
  );
  r.post(
    '/assistant',
    asyncRoute(async (req, res) => {
      const a: Actor = res.locals.actor;
      if (!family.includes(a.active!.role)) throw notFound();
      const { question, ...query } = individual
        .extend({ question: z.string().trim().min(3).max(500) })
        .parse(req.body);
      const performance = await read(a, query);
      const facts = academicFacts(performance);
      const topic = assistantQuestion(question, performance);
      const key = analysisKey([
        a.context.schoolId,
        performance.profile.id,
        'assistant',
        facts,
        topic,
      ]);
      const answer = await ai.answer(facts, topic, key);
      await read(a, query);
      res.json(answer);
    }),
  );
  r.post(
    '/guidance',
    asyncRoute(async (req, res) => {
      const a: Actor = res.locals.actor;
      const query = individual.parse(req.body);
      const performance = await read(a, query);
      const school = a.context.schoolId;
      const id = performance.profile.id;
      const facts = academicFacts(performance);
      // Keep a single shared plan for learners, linked parents and school staff.
      // Optional class benchmarks are still available in the scoped view and assistant.
      facts.subjects = facts.subjects.map((subject) => ({ ...subject, class_average: null }));
      const planId = analysisKey([
        school,
        id,
        performance.report.exam.id,
        performance.subjects.map((subject) => subject.id),
        performance.trend.map((item) => item.exam_id),
        facts,
      ]);
      if (a.active!.role === 'teacher') {
        const advice = await ai.advice(facts, planId);
        await read(a, query);
        res.json({ plan_id: planId, advice, completed: [] });
        return;
      }
      async function stored(tx: Tx) {
        return (
          await tx.query<{ advice: unknown }>(
            'SELECT advice FROM academic_study_plans WHERE school_id=$1 AND student_id=$2 AND plan_id=$3',
            [school, id, planId],
          )
        ).rows[0];
      }
      const existing = await transaction(pool, a.context, stored, true);
      const generated = existing ? undefined : await ai.advice(facts, planId);
      res.json(
        await transaction(pool, a.context, async (tx) => {
          await learner(tx, a, id);
          if (generated)
            await tx.query(
              'INSERT INTO academic_study_plans(school_id,student_id,plan_id,advice) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
              [school, id, planId, generated],
            );
          const plan = await stored(tx);
          if (!plan) throw notFound();
          const completed = (
            await tx.query<{ task: number }>(
              'SELECT task FROM academic_study_progress WHERE school_id=$1 AND student_id=$2 AND plan_id=$3 ORDER BY task',
              [school, id, planId],
            )
          ).rows.map((row) => row.task);
          return { plan_id: planId, advice: academicAdviceSchema.parse(plan.advice), completed };
        }),
      );
    }),
  );
  r.put(
    '/progress',
    asyncRoute(async (req, res) => {
      const a: Actor = res.locals.actor;
      if (a.active!.role !== 'student') throw notFound();
      const body = z
        .object({
          plan_id: z.string().regex(/^[0-9a-f]{64}$/),
          task: z.number().int().min(0).max(20),
          completed: z.boolean(),
        })
        .strict()
        .parse(req.body);
      await transaction(pool, a.context, async (tx) => {
        const id = await learner(tx, a, undefined);
        const args = [a.context.schoolId, id, body.plan_id, body.task];
        const exists = (
          await tx.query(
            "SELECT 1 FROM academic_study_plans WHERE school_id=$1 AND student_id=$2 AND plan_id=$3 AND jsonb_array_length(advice->'tasks')>$4",
            args,
          )
        ).rowCount;
        if (!exists) throw notFound();
        if (body.completed)
          await tx.query(
            'INSERT INTO academic_study_progress VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
            args,
          );
        else
          await tx.query(
            'DELETE FROM academic_study_progress WHERE school_id=$1 AND student_id=$2 AND plan_id=$3 AND task=$4',
            args,
          );
      });
      res.status(204).end();
    }),
  );
  return r;
}
