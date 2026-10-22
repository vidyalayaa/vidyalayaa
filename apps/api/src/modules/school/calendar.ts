import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import {
  calendarEventSchema,
  calendarEventUpdateSchema,
  calendarDeleteSchema,
  calendarKinds,
  uuid,
  date,
  type CalendarEventInput,
} from '@vidyalayaa/contracts';
import { transaction, type Tx } from '../../lib/db.js';
import { paged } from '../../lib/pagination.js';
import { asyncRoute, ApiError, notFound } from '../../lib/errors.js';
import type { Actor } from '../../middleware/auth.js';

interface Writes {
  requireWrite: (tx: Tx, a: Actor, feature?: string) => Promise<void>;
  withIdempotency: <T>(
    tx: Tx,
    a: Actor,
    key: string | undefined,
    body: unknown,
    fn: () => Promise<T>,
  ) => Promise<T>;
}
const classSelect = `SELECT c.id,c.grade,c.section,c.academic_session_id,ac.name AS session_name,ac.is_current,c.retired_at
 FROM classes c JOIN academic_sessions ac ON ac.school_id=c.school_id AND ac.id=c.academic_session_id`;
// Project target labels through the caller's class access as well as event RLS.
const select = `SELECT t.id,coalesce(nullif(btrim(t.label),''),'School calendar event') AS title,t.description,t.kind,
 to_char(t.on_date,'YYYY-MM-DD') AS start_date,to_char(coalesce(t.ends_on,t.on_date),'YYYY-MM-DD') AS end_date,
 CASE WHEN cardinality(t.target_class_ids)=0 THEN 'SCHOOL' ELSE 'CLASSES' END AS audience,t.version,
 ARRAY(SELECT cid FROM unnest(t.target_class_ids) cid WHERE app.calendar_class_visible(t.school_id,cid) ORDER BY cid) AS class_ids,
 coalesce((SELECT jsonb_agg(jsonb_build_object('id',c.id,'grade',c.grade,'section',c.section,'academic_session_id',c.academic_session_id,
 'session_name',ac.name,'is_current',ac.is_current,'retired_at',c.retired_at) ORDER BY c.grade,c.section,c.id)
 FROM classes c JOIN academic_sessions ac ON ac.school_id=c.school_id AND ac.id=c.academic_session_id
 WHERE c.school_id=t.school_id AND c.id=ANY(t.target_class_ids) AND app.calendar_class_visible(c.school_id,c.id)),'[]'::jsonb) AS targets
 FROM school_holidays t`;
const rangeSchema = z
  .object({
    from: date,
    to: date,
    kind: z.enum(calendarKinds).optional(),
    class_ids: z
      .string()
      .max(37000)
      .optional()
      .transform((v) => (v ? v.split(',') : []))
      .pipe(z.array(uuid).max(1000)),
  })
  .superRefine((v, ctx) => {
    const days = (Date.parse(v.to) - Date.parse(v.from)) / 86400000;
    if (days < 0 || days > 366)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['to'],
        message: 'Choose a date range of up to one calendar year.',
      });
  });
async function event(tx: Tx, a: Actor, id: string, lock = false) {
  const row = (
    await tx.query(
      `${select} WHERE t.school_id=$1 AND t.id=$2 AND t.retired_at IS NULL${lock ? ' FOR UPDATE OF t' : ''}`,
      [a.context.schoolId, id],
    )
  ).rows[0];
  if (!row) throw notFound();
  return row;
}
async function saveTargets(tx: Tx, a: Actor, b: CalendarEventInput, previous: string[] = []) {
  if (!b.class_ids.length) return;
  const rows = await tx.query(
    `SELECT id FROM classes WHERE school_id=$1 AND id=ANY($2::uuid[]) AND (retired_at IS NULL OR id=ANY($3::uuid[])) FOR KEY SHARE`,
    [a.context.schoolId, b.class_ids, previous],
  );
  if (rows.rowCount !== b.class_ids.length)
    throw new ApiError(
      422,
      'INVALID_CALENDAR_TARGET',
      'Choose existing classes and sections in this school. Archived sections cannot be added as new targets.',
    );
}
function checkVersion(actual: number, expected: number) {
  if (actual !== expected)
    throw new ApiError(
      409,
      'CALENDAR_VERSION_CONFLICT',
      'This event changed. Refresh the calendar before saving again.',
    );
}
async function calendarAudit(
  tx: Tx,
  a: Actor,
  action: string,
  id: string,
  before: unknown,
  after: unknown,
) {
  await tx.query(
    "INSERT INTO audit_logs(school_id,actor_type,actor_id,action,entity_type,entity_id,before,after) VALUES($1,'USER',$2,$3,'school_holidays',$4,$5::jsonb,$6::jsonb)",
    [
      a.context.schoolId,
      a.id,
      action,
      id,
      before ? JSON.stringify(before) : null,
      JSON.stringify(after),
    ],
  );
}
export function calendarRouter(pool: pg.Pool, writes: Writes) {
  const r = Router();
  r.use((_req, res, next) => {
    const a: Actor = res.locals.actor;
    if (!a.active?.permissions.includes('calendar.read'))
      return next(new ApiError(403, 'FORBIDDEN', 'School calendar access is required.'));
    next();
  });
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
              `${classSelect} WHERE c.school_id=$1 AND c.retired_at IS NULL AND ac.retired_at IS NULL AND app.calendar_class_visible(c.school_id,c.id) ORDER BY ac.starts_on DESC,c.grade,c.section,c.id`,
              [a.context.schoolId],
              req.query,
            ),
          true,
        ),
      );
    }),
  );
  r.get(
    '/events',
    asyncRoute(async (req, res) => {
      const a: Actor = res.locals.actor,
        q = rangeSchema.parse(req.query);
      res.json(
        await transaction(
          pool,
          a.context,
          async (tx) => {
            if (q.class_ids.length) {
              const permitted = await tx.query(
                'SELECT id FROM classes WHERE school_id=$1 AND id=ANY($2::uuid[]) AND retired_at IS NULL AND app.calendar_class_visible(school_id,id)',
                [a.context.schoolId, q.class_ids],
              );
              if (permitted.rowCount !== new Set(q.class_ids).size) throw notFound();
            }
            return paged(
              tx,
              `${select} WHERE t.school_id=$1 AND t.retired_at IS NULL AND t.on_date<=$3::date AND coalesce(t.ends_on,t.on_date)>=$2::date
       AND ($4::text IS NULL OR t.kind=$4) AND (cardinality($5::uuid[])=0 OR cardinality(t.target_class_ids)=0 OR t.target_class_ids&&$5::uuid[])
       ORDER BY t.on_date,t.label,t.id`,
              [a.context.schoolId, q.from, q.to, q.kind || null, q.class_ids],
              req.query,
            );
          },
          true,
        ),
      );
    }),
  );
  r.get(
    '/events/:id',
    asyncRoute(async (req, res) => {
      const a: Actor = res.locals.actor,
        id = uuid.parse(req.params.id);
      res.json(await transaction(pool, a.context, (tx) => event(tx, a, id), true));
    }),
  );
  // All write paths, including compatibility resource routes, are also protected by RLS.
  r.use((_req, res, next) => {
    const a: Actor = res.locals.actor;
    if (a.active?.role !== 'school_admin' || !a.active.permissions.includes('calendar.write'))
      return next(new ApiError(403, 'FORBIDDEN', 'Only School Admin can manage calendar events.'));
    next();
  });
  r.post(
    '/events',
    asyncRoute(async (req, res) => {
      const a: Actor = res.locals.actor,
        b = calendarEventSchema.parse(req.body);
      res.status(201).json(
        await transaction(pool, a.context, async (tx) => {
          await writes.requireWrite(tx, a);
          return writes.withIdempotency(
            tx,
            a,
            req.header('Idempotency-Key'),
            { action: 'calendar.create', ...b },
            async () => {
              await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
                `${a.context.schoolId}:school_holidays`,
              ]);
              await saveTargets(tx, a, b);
              const row = (
                await tx.query(
                  `INSERT INTO school_holidays(school_id,label,description,kind,on_date,ends_on,target_class_ids) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
                  [
                    a.context.schoolId,
                    b.title,
                    b.description,
                    b.kind,
                    b.start_date,
                    b.end_date,
                    b.class_ids,
                  ],
                )
              ).rows[0];
              const saved = await event(tx, a, row.id);
              await calendarAudit(tx, a, 'calendar.create', row.id, null, saved);
              return saved;
            },
          );
        }),
      );
    }),
  );
  r.patch(
    '/events/:id',
    asyncRoute(async (req, res) => {
      const a: Actor = res.locals.actor,
        id = uuid.parse(req.params.id),
        b = calendarEventUpdateSchema.parse(req.body);
      res.json(
        await transaction(pool, a.context, async (tx) => {
          await writes.requireWrite(tx, a);
          return writes.withIdempotency(
            tx,
            a,
            req.header('Idempotency-Key'),
            { action: 'calendar.update', id, ...b },
            async () => {
              await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
                `${a.context.schoolId}:school_holidays`,
              ]);
              const before = await event(tx, a, id, true);
              checkVersion(before.version, b.expected_version);
              await saveTargets(tx, a, b, before.class_ids);
              await tx.query(
                `UPDATE school_holidays SET label=$3,description=$4,kind=$5,on_date=$6,ends_on=$7,target_class_ids=$8 WHERE school_id=$1 AND id=$2`,
                [
                  a.context.schoolId,
                  id,
                  b.title,
                  b.description,
                  b.kind,
                  b.start_date,
                  b.end_date,
                  b.class_ids,
                ],
              );
              const saved = await event(tx, a, id);
              await calendarAudit(tx, a, 'calendar.update', id, before, saved);
              return saved;
            },
          );
        }),
      );
    }),
  );
  r.delete(
    '/events/:id',
    asyncRoute(async (req, res) => {
      const a: Actor = res.locals.actor,
        id = uuid.parse(req.params.id),
        b = calendarDeleteSchema.parse(req.body);
      res.json(
        await transaction(pool, a.context, async (tx) => {
          await writes.requireWrite(tx, a);
          return writes.withIdempotency(
            tx,
            a,
            req.header('Idempotency-Key'),
            { action: 'calendar.delete', id, ...b },
            async () => {
              const before = await event(tx, a, id, true);
              checkVersion(before.version, b.expected_version);
              await tx.query(
                'UPDATE school_holidays SET retired_at=now() WHERE school_id=$1 AND id=$2',
                [a.context.schoolId, id],
              );
              await calendarAudit(tx, a, 'calendar.delete', id, before, { retired: true });
              return { id, deleted: true };
            },
          );
        }),
      );
    }),
  );
  return r;
}
