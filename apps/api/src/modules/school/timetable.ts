import { Router } from 'express';
import type pg from 'pg';
import { defaultSchoolTimings, schoolTimingsUpdateSchema, uuid } from '@vidyalayaa/contracts';
import { transaction, audit, type Tx } from '../../lib/db.js';
import { paged } from '../../lib/pagination.js';
import { asyncRoute, ApiError, notFound } from '../../lib/errors.js';
import type { Actor } from '../../middleware/auth.js';

interface Controls {
  requireWrite: (tx: Tx, a: Actor, feature?: string) => Promise<void>;
  withIdempotency: <T>(
    tx: Tx,
    a: Actor,
    key: string | undefined,
    body: unknown,
    fn: () => Promise<T>,
  ) => Promise<T>;
}
async function assertVisible(tx: Tx, a: Actor, id: string) {
  if (
    !(
      await tx.query('SELECT app.timetable_class_visible($1,$2) AS allowed', [
        a.context.schoolId,
        id,
      ])
    ).rows[0]?.allowed
  )
    throw notFound();
}
export function timetableRouter(pool: pg.Pool, controls: Controls) {
  const r = Router();
  r.use((_req, res, next) => {
    const a: Actor = res.locals.actor;
    if (!a.active?.permissions.includes('timetable.read'))
      return next(new ApiError(403, 'FORBIDDEN', 'Timetable access is required.'));
    if (!a.features.timetable)
      return next(
        new ApiError(403, 'FEATURE_UNAVAILABLE', 'Your plan does not include timetables.'),
      );
    next();
  });
  r.get(
    '/clock',
    asyncRoute(async (_req, res) => {
      const a: Actor = res.locals.actor;
      res.setHeader('Cache-Control', 'no-store');
      res.json({ server_time: new Date().toISOString(), timezone: a.active!.timezone });
    }),
  );
  r.get(
    '/mine',
    asyncRoute(async (req, res) => {
      const a: Actor = res.locals.actor;
      if (a.active!.role !== 'teacher')
        throw new ApiError(403, 'FORBIDDEN', 'A teacher account is required for My Timetable.');
      res.json(
        await transaction(
          pool,
          a.context,
          (tx) =>
            paged(
              tx,
              `SELECT t.*,labels.*,true AS assignment_valid
       FROM timetable_entries t JOIN teachers own ON own.school_id=t.school_id AND own.id=t.teacher_id
       CROSS JOIN LATERAL app.timetable_entry_labels(t.school_id,t.id) labels
       WHERE t.school_id=$1 AND own.user_id=$2 AND own.status='ACTIVE' AND own.staff_role='teacher' AND t.retired_at IS NULL
       AND app.timetable_assignment_valid(t.school_id,t.class_id,t.subject_id,t.teacher_id)
       ORDER BY t.weekday,t.starts_at,t.ends_at,t.id`,
              [a.context.schoolId, a.id],
              req.query,
            ),
          true,
        ),
      );
    }),
  );
  r.get(
    '/settings',
    asyncRoute(async (_req, res) => {
      const a: Actor = res.locals.actor;
      const config = await transaction(
        pool,
        a.context,
        async (tx) =>
          (
            await tx.query("SELECT settings->'timetable' AS config FROM schools WHERE id=$1", [
              a.context.schoolId,
            ])
          ).rows[0]?.config,
        true,
      );
      if (!config)
        return res.json({ configured: false, version: 0, settings: defaultSchoolTimings });
      const { version, ...settings } = config;
      res.json({ configured: true, version, settings });
    }),
  );
  r.get(
    '/classes',
    asyncRoute(async (req, res) => {
      const a: Actor = res.locals.actor;
      res.json(
        await transaction(
          pool,
          a.context,
          (tx) =>
            paged(
              tx,
              `SELECT c.id,c.grade,c.section,ac.name AS session_name FROM classes c JOIN academic_sessions ac ON ac.school_id=c.school_id AND ac.id=c.academic_session_id
       WHERE c.school_id=$1 AND app.timetable_class_visible(c.school_id,c.id) ORDER BY ac.starts_on DESC,c.grade,c.section,c.id`,
              [a.context.schoolId],
              req.query,
            ),
          true,
        ),
      );
    }),
  );
  r.get(
    '/classes/:id/entries',
    asyncRoute(async (req, res) => {
      const a: Actor = res.locals.actor,
        id = uuid.parse(req.params.id);
      res.json(
        await transaction(
          pool,
          a.context,
          async (tx) => {
            await assertVisible(tx, a, id);
            return paged(
              tx,
              `SELECT t.*,labels.*,${a.active!.role === 'school_admin' ? 'app.timetable_assignment_valid(t.school_id,t.class_id,t.subject_id,t.teacher_id)' : 'true'} AS assignment_valid
        FROM timetable_entries t CROSS JOIN LATERAL app.timetable_entry_labels(t.school_id,t.id) labels
        WHERE t.school_id=$1 AND t.class_id=$2 AND t.retired_at IS NULL ORDER BY t.weekday,t.starts_at,t.id`,
              [a.context.schoolId, id],
              req.query,
            );
          },
          true,
        ),
      );
    }),
  );
  r.use((_req, res, next) => {
    const a: Actor = res.locals.actor;
    if (a.active?.role !== 'school_admin' || !a.active.permissions.includes('timetable.write'))
      return next(new ApiError(403, 'FORBIDDEN', 'Only School Admin can manage the timetable.'));
    next();
  });
  r.get(
    '/classes/:id/assignments',
    asyncRoute(async (req, res) => {
      const a: Actor = res.locals.actor,
        id = uuid.parse(req.params.id);
      res.json(
        await transaction(
          pool,
          a.context,
          async (tx) => {
            await assertVisible(tx, a, id);
            return paged(
              tx,
              `SELECT DISTINCT s.id::text||':'||te.id::text AS id,s.id AS subject_id,s.name AS subject_label,te.id AS teacher_id,te.full_name AS teacher_label
        FROM teacher_class_assignments ta JOIN subjects s ON s.school_id=ta.school_id AND s.id=ta.subject_id JOIN teachers te ON te.school_id=ta.school_id AND te.id=ta.teacher_id
        WHERE ta.school_id=$1 AND ta.class_id=$2 AND app.timetable_assignment_valid(ta.school_id,ta.class_id,ta.subject_id,ta.teacher_id)
        ORDER BY subject_label,teacher_label,id`,
              [a.context.schoolId, id],
              req.query,
            );
          },
          true,
        ),
      );
    }),
  );
  r.put(
    '/settings',
    asyncRoute(async (req, res) => {
      const a: Actor = res.locals.actor,
        b = schoolTimingsUpdateSchema.parse(req.body);
      res.json(
        await transaction(pool, a.context, async (tx) => {
          await controls.requireWrite(tx, a, 'timetable');
          return controls.withIdempotency(
            tx,
            a,
            req.header('Idempotency-Key'),
            { action: 'timetable.settings', ...b },
            async () => {
              const row = (
                await tx.query(
                  "SELECT coalesce((settings->'timetable'->>'version')::int,0) AS version FROM schools WHERE id=$1 FOR UPDATE",
                  [a.context.schoolId],
                )
              ).rows[0];
              if (!row) throw notFound();
              if (row.version !== b.expected_version)
                throw new ApiError(
                  409,
                  'TIMETABLE_VERSION_CONFLICT',
                  'School timings changed. Refresh before saving again.',
                );
              const config = { ...b.settings, version: row.version + 1 };
              await tx.query(
                "UPDATE schools SET settings=jsonb_set(settings,'{timetable}',$2::jsonb,true) WHERE id=$1",
                [a.context.schoolId, JSON.stringify(config)],
              );
              await audit(
                tx,
                a.context.schoolId,
                a.id,
                'timetable.timings.updated',
                'schools',
                a.context.schoolId,
              );
              return { configured: true, version: config.version, settings: b.settings };
            },
          );
        }),
      );
    }),
  );
  return r;
}
