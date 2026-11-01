import { Router } from 'express';
import type pg from 'pg';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  prepareYearSchema,
  promotionPlanSchema,
  uuid,
  type PromotionPlan,
  type PromotionWorkspace,
  type PromotionPreview,
  type PromotionStudent,
  type PromotionClass,
} from '@vidyalayaa/contracts';
import { transaction, audit, type Tx } from '../../lib/db.js';
import { ApiError, asyncRoute, notFound } from '../../lib/errors.js';
import type { Actor } from '../../middleware/auth.js';
import { hash } from '../../lib/crypto.js';
import { localParts } from '../attendance/engine.js';
import { assessClassFees } from './fees.js';
import { yearHistoryRouter } from './year-history.js';

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
const fail = (message: string) => new ApiError(409, 'PROMOTION_REVIEW_REQUIRED', message);
const iso = (v: unknown) =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
const canonical = (value: any): string =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
const cents = (v: string) => {
  const [whole, fraction = ''] = v.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
};
const money = (v: bigint) => `${v / 100n}.${String(v % 100n).padStart(2, '0')}`;
const shiftFeeDay = (date: string, oldStart: string, newStart: string) => {
  const monthOffset =
    (Number(newStart.slice(0, 4)) - Number(oldStart.slice(0, 4))) * 12 +
    Number(newStart.slice(5, 7)) -
    Number(oldStart.slice(5, 7));
  const d = new Date(date + 'T12:00:00Z'),
    day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + monthOffset);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
};
async function year(tx: Tx, sid: string, id: string, lock = false) {
  const r = (
    await tx.query(
      `SELECT *,starts_on::text AS starts_on,ends_on::text AS ends_on FROM academic_sessions WHERE school_id=$1 AND id=$2 AND retired_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
      [sid, id],
    )
  ).rows[0];
  if (!r) throw notFound();
  return r;
}
async function classes(tx: Tx, sid: string, ids: string[]) {
  return (
    await tx.query<PromotionClass>(
      `SELECT c.id,c.grade,c.section,c.academic_session_id,c.class_teacher_id,te.full_name AS class_teacher,(te.status='ACTIVE' AND te.staff_role='teacher') AS teacher_active,(SELECT count(*)::int FROM teacher_class_assignments ta WHERE ta.school_id=c.school_id AND ta.class_id=c.id AND ta.retired_at IS NULL AND ta.subject_id IS NOT NULL) AS subjects,(SELECT count(*)::int FROM timetable_entries tt WHERE tt.school_id=c.school_id AND tt.class_id=c.id AND tt.retired_at IS NULL) AS timetable_periods FROM classes c LEFT JOIN teachers te ON te.school_id=c.school_id AND te.id=c.class_teacher_id WHERE c.school_id=$1 AND c.academic_session_id=ANY($2::uuid[]) AND c.retired_at IS NULL ORDER BY c.academic_session_id,c.grade,c.section,c.id`,
      [sid, ids],
    )
  ).rows;
}
async function roster(tx: Tx, sid: string, source: string) {
  return (
    await tx.query<PromotionStudent>(
      `SELECT e.id,e.student_id,s.student_code,concat_ws(' ',s.first_name,s.last_name) AS student_name,e.class_id,c.grade,c.section,e.roll_number,e.starts_on::text AS starts_on,e.ends_on::text AS ends_on,e.updated_at FROM enrollments e JOIN students s ON s.school_id=e.school_id AND s.id=e.student_id JOIN classes c ON c.school_id=e.school_id AND c.id=e.class_id WHERE e.school_id=$1 AND e.academic_session_id=$2 AND e.status='ACTIVE' AND s.status='ACTIVE' ORDER BY c.grade,c.section,s.first_name,s.student_code,e.id`,
      [sid, source],
    )
  ).rows;
}
async function snapshot(tx: Tx, sid: string, source: string, target: string) {
  const queries = [
    ['years', `SELECT * FROM academic_sessions WHERE school_id=$1 AND id IN($2,$3) ORDER BY id`],
    [
      'classes',
      `SELECT * FROM classes WHERE school_id=$1 AND academic_session_id IN($2,$3) ORDER BY id`,
    ],
    [
      'enrollments',
      `SELECT * FROM enrollments WHERE school_id=$1 AND academic_session_id IN($2,$3) ORDER BY id`,
    ],
    [
      'students',
      `SELECT s.* FROM students s WHERE s.school_id=$1 AND EXISTS(SELECT FROM enrollments e WHERE e.school_id=s.school_id AND e.student_id=s.id AND e.academic_session_id IN($2,$3)) ORDER BY s.id`,
    ],
    [
      'teaching',
      `SELECT ta.* FROM teacher_class_assignments ta JOIN classes c ON c.school_id=ta.school_id AND c.id=ta.class_id WHERE ta.school_id=$1 AND c.academic_session_id IN($2,$3) ORDER BY ta.id`,
    ],
    [
      'teachers',
      `SELECT te.* FROM teachers te WHERE te.school_id=$1 AND EXISTS(SELECT FROM classes c WHERE c.school_id=te.school_id AND c.academic_session_id IN($2,$3) AND (c.class_teacher_id=te.id OR EXISTS(SELECT FROM teacher_class_assignments ta WHERE ta.school_id=c.school_id AND ta.class_id=c.id AND ta.teacher_id=te.id))) ORDER BY te.id`,
    ],
    [
      'timetable',
      `SELECT tt.* FROM timetable_entries tt WHERE tt.school_id=$1 AND tt.academic_session_id IN($2,$3) ORDER BY tt.id`,
    ],
    [
      'structures',
      `SELECT * FROM fee_structures WHERE school_id=$1 AND academic_session_id IN($2,$3) ORDER BY id`,
    ],
    [
      'fees',
      `SELECT f.* FROM fee_records f WHERE f.school_id=$1 AND EXISTS(SELECT FROM enrollments e WHERE e.school_id=f.school_id AND e.student_id=f.student_id AND e.academic_session_id IN($2,$3)) ORDER BY f.id`,
    ],
    [
      'timings',
      `SELECT settings->'timetable' AS timetable FROM schools WHERE id=$1 AND $2::uuid IS NOT NULL AND $3::uuid IS NOT NULL`,
    ],
  ];
  const result: Record<string, unknown> = {};
  for (const [key, sql] of queries) result[key] = (await tx.query(sql, [sid, source, target])).rows;
  return hash(canonical(result));
}
export function promotionRouter(pool: pg.Pool, controls: Controls, secret: string) {
  const r = Router();
  r.use((_req, res, next) => {
    const a: Actor = res.locals.actor;
    if (
      a.active?.role !== 'school_admin' ||
      !['academics.read', 'students.read', 'teachers.read', 'fees.read'].every((p) =>
        a.active!.permissions.includes(p),
      )
    )
      return next(
        new ApiError(
          403,
          'FORBIDDEN',
          'School Admin access is required for academic-year promotion.',
        ),
      );
    next();
  });
  r.use('/history', yearHistoryRouter(pool));
  async function writable(tx: Tx, a: Actor) {
    if (
      !['academics.write', 'students.write', 'teachers.write', 'fees.write'].every((p) =>
        a.active!.permissions.includes(p),
      )
    )
      throw new ApiError(
        403,
        'FORBIDDEN',
        'Academic, student, teacher and fee management permissions are required.',
      );
    await controls.requireWrite(tx, a);
  }
  r.get(
    '/workspace',
    asyncRoute(async (_req, res) => {
      const a: Actor = res.locals.actor;
      res.json(
        await transaction(
          pool,
          a.context,
          async (tx) => {
            const years = (
              await tx.query(
                'SELECT id,name,starts_on::text AS starts_on,ends_on::text AS ends_on,is_current,closed_at FROM academic_sessions WHERE school_id=$1 AND retired_at IS NULL ORDER BY starts_on DESC,id',
                [a.context.schoolId],
              )
            ).rows;
            return {
              years,
              classes: await classes(
                tx,
                a.context.schoolId,
                years.map((y) => y.id),
              ),
              students: [],
              structures: (
                await tx.query(
                  `SELECT st.id,st.academic_session_id,st.grade,st.version,(SELECT coalesce(jsonb_agg(sec.class_id),'[]') FROM fee_structure_sections sec WHERE sec.school_id=st.school_id AND sec.structure_id=st.id) AS class_ids,(SELECT count(*)::int FROM fee_structure_items it WHERE it.school_id=st.school_id AND it.structure_id=st.id) AS items FROM fee_structures st WHERE st.school_id=$1 ORDER BY st.version DESC,st.id`,
                  [a.context.schoolId],
                )
              ).rows,
              runs: (
                await tx.query(
                  'SELECT * FROM academic_promotions WHERE school_id=$1 ORDER BY created_at DESC,id',
                  [a.context.schoolId],
                )
              ).rows,
              today: localParts(new Date(), a.active!.timezone).date,
            };
          },
          true,
        ),
      );
    }),
  );
  r.get(
    '/:id/students',
    asyncRoute(async (req, res) => {
      const a: Actor = res.locals.actor;
      const run = (
        await transaction(
          pool,
          a.context,
          (tx) =>
            tx.query(
              'SELECT source_session_id FROM academic_promotions WHERE school_id=$1 AND id=$2',
              [a.context.schoolId, uuid.parse(req.params.id)],
            ),
          true,
        )
      ).rows[0];
      if (!run) throw notFound();
      res.json({
        data: await transaction(
          pool,
          a.context,
          (tx) => roster(tx, a.context.schoolId, run.source_session_id),
          true,
        ),
      });
    }),
  );
  r.post(
    '/prepare',
    asyncRoute(async (req, res) => {
      const a: Actor = res.locals.actor,
        b = prepareYearSchema.parse(req.body);
      if (b.copy_timetable && !a.features.timetable)
        throw new ApiError(403, 'FEATURE_UNAVAILABLE', 'Your plan does not include timetables.');
      if (b.copy_timetable && !a.active!.permissions.includes('timetable.write'))
        throw new ApiError(403, 'FORBIDDEN', 'Timetable management permission is required.');
      if (!req.header('Idempotency-Key'))
        throw new ApiError(422, 'IDEMPOTENCY_REQUIRED', 'A preparation key is required.');
      const result = await transaction(pool, a.context, async (tx) => {
        await writable(tx, a);
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          a.context.schoolId + ':academic-promotion',
        ]);
        return controls.withIdempotency(tx, a, req.header('Idempotency-Key'), b, async () => {
          const sid = a.context.schoolId,
            source = await year(tx, sid, b.source_session_id, true);
          if (!source.is_current || source.closed_at)
            throw fail('Prepare from the current open academic year.');
          let target;
          if (b.new_year) {
            if (
              b.new_year.starts_on <= source.ends_on ||
              b.new_year.ends_on <= b.new_year.starts_on
            )
              throw fail('The new academic year must start after the previous year ends.');
            target = (
              await tx.query(
                'INSERT INTO academic_sessions(school_id,name,starts_on,ends_on,is_current) VALUES($1,$2,$3,$4,false) RETURNING *,starts_on::text AS starts_on,ends_on::text AS ends_on',
                [sid, b.new_year.name, b.new_year.starts_on, b.new_year.ends_on],
              )
            ).rows[0];
          } else target = await year(tx, sid, b.target_session_id!, true);
          if (target.closed_at || target.is_current || target.starts_on <= source.ends_on)
            throw fail('Choose a later, open, inactive academic year.');
          if (
            (
              await tx.query(
                'SELECT id FROM academic_promotions WHERE school_id=$1 AND target_session_id=$2',
                [sid, target.id],
              )
            ).rowCount
          )
            throw fail('This target year is already prepared. Resume its existing promotion.');
          if (
            (
              await tx.query(
                'SELECT id FROM enrollments WHERE school_id=$1 AND academic_session_id=$2',
                [sid, target.id],
              )
            ).rowCount
          )
            throw fail(
              'The target year already has enrollments. Choose an empty year before preparing promotion.',
            );
          const existing = (
            await tx.query(
              'SELECT id FROM classes WHERE school_id=$1 AND academic_session_id=$2 AND retired_at IS NULL',
              [sid, target.id],
            )
          ).rowCount;
          if (existing && (b.copy_teaching || b.copy_timetable || b.copy_fees))
            throw fail(
              'The target already has classes. Keep its configuration by turning off copy options, or select a new year.',
            );
          const copies: { source_class_id: string; target_class_id: string }[] = [];
          if (!existing) {
            const old = await classes(tx, sid, [source.id]);
            if (!old.length)
              throw fail('Add classes to the current year before preparing promotion.');
            for (const c of old) {
              if (!c.teacher_active)
                throw fail(
                  `Class ${c.grade} ${c.section} needs an active Class Teacher before copying.`,
                );
              const created = (
                await tx.query(
                  'INSERT INTO classes(school_id,academic_session_id,grade,section,class_teacher_id) VALUES($1,$2,$3,$4,$5) RETURNING id',
                  [sid, target.id, c.grade, c.section, c.class_teacher_id],
                )
              ).rows[0];
              copies.push({ source_class_id: c.id, target_class_id: created.id });
            }
            if (b.copy_teaching) {
              for (const c of copies)
                await tx.query(
                  `INSERT INTO teacher_class_assignments(school_id,class_id,subject_id,teacher_id,starts_on,ends_on) SELECT ta.school_id,$3,ta.subject_id,ta.teacher_id,$4::date,$5::date FROM teacher_class_assignments ta JOIN teachers te ON te.school_id=ta.school_id AND te.id=ta.teacher_id JOIN subjects s ON s.school_id=ta.school_id AND s.id=ta.subject_id WHERE ta.school_id=$1 AND ta.class_id=$2 AND ta.retired_at IS NULL AND te.status='ACTIVE' AND s.retired_at IS NULL AND ta.starts_on<=least((now() AT TIME ZONE $6)::date,$7::date) AND (ta.ends_on IS NULL OR ta.ends_on>=least((now() AT TIME ZONE $6)::date,$7::date))`,
                  [
                    sid,
                    c.source_class_id,
                    c.target_class_id,
                    target.starts_on,
                    target.ends_on,
                    a.active!.timezone,
                    source.ends_on,
                  ],
                );
            }
            if (b.copy_timetable) {
              for (const c of copies)
                await tx.query(
                  `INSERT INTO timetable_entries(school_id,class_id,subject_id,teacher_id,weekday,starts_at,ends_at,room) SELECT school_id,$3,subject_id,teacher_id,weekday,starts_at,ends_at,room FROM timetable_entries WHERE school_id=$1 AND class_id=$2 AND retired_at IS NULL ORDER BY weekday,starts_at,id`,
                  [sid, c.source_class_id, c.target_class_id],
                );
            }
            if (b.copy_fees) {
              const oldStructures = (
                await tx.query(
                  'SELECT DISTINCT ON(grade) * FROM fee_structures WHERE school_id=$1 AND academic_session_id=$2 ORDER BY grade,version DESC,id',
                  [sid, source.id],
                )
              ).rows;
              for (const st of oldStructures) {
                const items = (
                  await tx.query(
                    "SELECT *,first_due_on::text AS first_due_on FROM fee_structure_items WHERE school_id=$1 AND structure_id=$2 AND category<>'ADMISSION' ORDER BY id",
                    [sid, st.id],
                  )
                ).rows;
                if (!items.length) continue;
                const next = (
                  await tx.query(
                    'INSERT INTO fee_structures(school_id,academic_session_id,grade,mode,version,created_by) VALUES($1,$2,$3,$4,1,$5) RETURNING id',
                    [sid, target.id, st.grade, st.mode, a.id],
                  )
                ).rows[0];
                const sections = (
                  await tx.query(
                    'SELECT class_id FROM fee_structure_sections WHERE school_id=$1 AND structure_id=$2',
                    [sid, st.id],
                  )
                ).rows;
                for (const sec of sections) {
                  const dest = copies.find((c) => c.source_class_id === sec.class_id);
                  if (dest)
                    await tx.query(
                      'INSERT INTO fee_structure_sections(school_id,structure_id,class_id) VALUES($1,$2,$3)',
                      [sid, next.id, dest.target_class_id],
                    );
                }
                for (const it of items) {
                  const dest = it.class_id
                    ? copies.find((c) => c.source_class_id === it.class_id)?.target_class_id
                    : null;
                  if (it.class_id && !dest) continue;
                  const due = shiftFeeDay(iso(it.first_due_on), source.starts_on, target.starts_on);
                  if (due < target.starts_on || due > target.ends_on)
                    throw fail(
                      'A copied fee due date falls outside the target year. Turn off fee copying and configure its fee plan manually.',
                    );
                  await tx.query(
                    'INSERT INTO fee_structure_items(school_id,structure_id,class_id,category,label,amount,frequency,first_due_on) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
                    [sid, next.id, dest, it.category, it.label, it.amount, it.frequency, due],
                  );
                }
              }
            }
          }
          const run = (
            await tx.query(
              'INSERT INTO academic_promotions(school_id,source_session_id,target_session_id,class_copies,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *',
              [sid, source.id, target.id, JSON.stringify(copies), a.id],
            )
          ).rows[0];
          await audit(tx, sid, a.id, 'academic_year.prepared', 'academic_promotions', run.id);
          return run;
        });
      });
      res.status(201).json(result);
    }),
  );

  type Choice = {
    row: PromotionStudent;
    outcome: string;
    target: PromotionClass | undefined;
    roll_number: string | null;
    reason: string | null;
  };
  async function buildPreview(tx: Tx, a: Actor, plan: PromotionPlan) {
    const sid = a.context.schoolId,
      run = (
        await tx.query('SELECT * FROM academic_promotions WHERE school_id=$1 AND id=$2', [
          sid,
          plan.promotion_id,
        ])
      ).rows[0];
    if (!run) throw notFound();
    const source = await year(tx, sid, run.source_session_id),
      target = await year(tx, sid, run.target_session_id),
      list = await classes(tx, sid, [source.id, target.id]),
      students = await roster(tx, sid, source.id),
      blockers: string[] = [],
      warnings: string[] = [];
    if (
      run.status !== 'PREPARED' ||
      !source.is_current ||
      source.closed_at ||
      target.closed_at ||
      target.is_current
    )
      blockers.push(
        'The source must be the current open year and the target must be prepared and inactive.',
      );
    if (
      plan.activation_on < target.starts_on ||
      plan.activation_on > target.ends_on ||
      plan.activation_on <= source.ends_on
    )
      blockers.push('Activation must be inside the new year and after the source year ends.');
    if (plan.activation_on > localParts(new Date(), a.active!.timezone).date)
      blockers.push(
        'This promotion is prepared for a future date. Return on or after the activation date to confirm.',
      );
    const mapping = new Map(plan.mappings.map((m) => [m.source_class_id, m]));
    if (mapping.size !== plan.mappings.length) blockers.push('Choose each source class only once.');
    const exceptions = new Map(plan.exceptions.map((e) => [e.enrollment_id, e]));
    if (exceptions.size !== plan.exceptions.length)
      blockers.push('Choose each student exception only once.');
    const validEnrollment = new Set(students.map((s) => s.id));
    if (plan.exceptions.some((e) => !validEnrollment.has(e.enrollment_id)))
      blockers.push('A student exception no longer belongs to the source roster.');
    for (const m of plan.mappings)
      if (
        !list.some((c) => c.id === m.source_class_id && c.academic_session_id === source.id) ||
        (m.target_class_id &&
          !list.some((c) => c.id === m.target_class_id && c.academic_session_id === target.id))
      )
        blockers.push('A class mapping belongs to another year or is unavailable.');
    const seen = new Set<string>(),
      rolls = new Set<string>(),
      nextRoll = new Map<string, number>();
    for (const current of (
      await tx.query(
        "SELECT class_id,roll_number FROM enrollments WHERE school_id=$1 AND academic_session_id=$2 AND status='ACTIVE'",
        [sid, target.id],
      )
    ).rows)
      if (current.roll_number)
        rolls.add(current.class_id + ':' + String(current.roll_number).toLowerCase());
    const choices: Choice[] = [];
    const counts = {
      promoted: 0,
      repeating: 0,
      graduated: 0,
      transferred: 0,
      withdrawn: 0,
      total: students.length,
    };
    for (const row of students) {
      if (seen.has(row.student_id))
        blockers.push(
          `${row.student_name} has multiple active enrollments. Resolve them before promotion.`,
        );
      seen.add(row.student_id);
      const ex = exceptions.get(row.id),
        m = mapping.get(row.class_id),
        outcome = ex?.outcome || m?.outcome || 'PROMOTE';
      const destId = ex ? ex.target_class_id : m?.target_class_id;
      const dest = list.find((c) => c.id === destId && c.academic_session_id === target.id);
      let roll = ex?.roll_number ?? row.roll_number;
      if (['PROMOTE', 'REPEAT'].includes(outcome)) {
        if (!dest) blockers.push(`Choose a destination for ${row.student_name}.`);
        else {
          if (!dest.teacher_active || !dest.class_teacher_id)
            blockers.push(`Class ${dest.grade} ${dest.section} needs an active Class Teacher.`);
          if (!dest.subjects)
            blockers.push(
              `Configure subjects and subject teachers for Class ${dest.grade} ${dest.section}.`,
            );
          if (outcome === 'REPEAT' && dest.grade !== row.grade)
            blockers.push(
              `A repeating student must stay in grade ${row.grade}: ${row.student_name}.`,
            );
          if (outcome === 'PROMOTE' && dest.grade === row.grade)
            warnings.push(
              `${row.student_name} remains in the same grade. Mark REPEAT if intentional.`,
            );
          if (plan.roll_numbers === 'RENUMBER') {
            let n = (nextRoll.get(dest.id) || 0) + 1;
            while (rolls.has(dest.id + ':' + String(n))) n++;
            nextRoll.set(dest.id, n);
            roll = String(n);
          }
          if (roll) {
            const key = dest.id + ':' + roll.toLowerCase();
            if (rolls.has(key))
              blockers.push(
                `Duplicate roll number ${roll} in Class ${dest.grade} ${dest.section}. Choose renumbering or override the student roll number.`,
              );
            rolls.add(key);
          }
        }
      } else if (destId)
        blockers.push(`Leaving students cannot have a new class: ${row.student_name}.`);
      if (row.starts_on > source.ends_on)
        blockers.push(`${row.student_name} has an invalid source enrollment start date.`);
      if (row.ends_on && row.ends_on < source.ends_on)
        warnings.push(
          `${row.student_name}'s current enrollment ends before the old year ends. Review their outcome.`,
        );
      const key = (
        {
          PROMOTE: 'promoted',
          REPEAT: 'repeating',
          GRADUATED: 'graduated',
          TRANSFERRED: 'transferred',
          WITHDRAWN: 'withdrawn',
        } as const
      )[outcome as 'PROMOTE'];
      counts[key]++;
      choices.push({ row, outcome, target: dest, roll_number: roll, reason: ex?.reason || null });
    }
    const existing = (
      await tx.query(
        'SELECT e.student_id FROM enrollments e WHERE e.school_id=$1 AND e.academic_session_id=$2 AND e.student_id=ANY($3::uuid[])',
        [sid, target.id, students.map((s) => s.student_id)],
      )
    ).rows;
    if (existing.length)
      blockers.push(
        'Some selected students already have target-year enrollments. Review them before promotion.',
      );
    const groups = new Map<string, Choice[]>();
    for (const c of choices)
      if (c.target && ['PROMOTE', 'REPEAT'].includes(c.outcome))
        groups.set(c.target.id, [...(groups.get(c.target.id) || []), c]);
    let amount = 0n,
      installments = 0;
    const selectedFees = new Map<string, string>();
    if (plan.generate_fees) {
      for (const [classId, rows] of groups) {
        const selected = plan.mappings
          .filter((m) => m.target_class_id === classId && m.fee_structure_id)
          .map((m) => m.fee_structure_id!);
        const exDest = rows.some((c) => exceptions.has(c.row.id));
        if (!selected.length && exDest) {
          const latest = (
            await tx.query(
              'SELECT st.id FROM fee_structures st JOIN fee_structure_sections sec ON sec.school_id=st.school_id AND sec.structure_id=st.id WHERE st.school_id=$1 AND st.academic_session_id=$2 AND sec.class_id=$3 ORDER BY st.version DESC LIMIT 1',
              [sid, target.id, classId],
            )
          ).rows[0];
          if (latest) selected.push(latest.id);
        }
        if (new Set(selected).size !== 1) {
          blockers.push(
            `Choose one fee structure for Class ${rows[0].target!.grade} ${rows[0].target!.section}.`,
          );
          continue;
        }
        const st = (
          await tx.query(
            'SELECT st.id FROM fee_structures st JOIN fee_structure_sections sec ON sec.school_id=st.school_id AND sec.structure_id=st.id WHERE st.school_id=$1 AND st.academic_session_id=$2 AND sec.class_id=$3 AND st.id=$4',
            [sid, target.id, classId, selected[0]],
          )
        ).rows[0];
        if (!st) {
          blockers.push('A selected fee plan does not belong to its destination class and year.');
          continue;
        }
        selectedFees.set(classId, st.id);
        const fee = (await assessClassFees(
          tx,
          a,
          { structure_id: st.id, class_id: classId },
          true,
          rows.map((c) => ({
            student_id: c.row.student_id,
            starts_on: plan.activation_on,
            ends_on: target.ends_on,
          })),
        )) as { installments: number; amount: string };
        installments += fee.installments;
        amount += cents(fee.amount);
      }
    } else
      warnings.push(
        'New-year fees will not be generated. Existing balances remain unchanged; fees can be assessed later in Fees.',
      );
    const balances = (
      await tx.query(
        `SELECT f.currency,coalesce(sum(f.amount_due-f.amount_paid),0)::text AS balance FROM fee_records f WHERE f.school_id=$1 AND f.student_id=ANY($2::uuid[]) AND f.voided_at IS NULL AND f.status<>'WAIVED' AND f.amount_due>f.amount_paid GROUP BY f.currency ORDER BY f.currency`,
        [sid, students.map((s) => s.student_id)],
      )
    ).rows;
    const snap = await snapshot(tx, sid, source.id, target.id);
    return {
      run,
      source,
      target,
      choices,
      selectedFees,
      snap,
      preview: {
        blockers: [...new Set(blockers)],
        warnings: [...new Set(warnings)],
        counts,
        fees: { installments, amount: money(amount), currency: 'INR' },
        old_balances: balances,
        students: choices.map((c) => ({
          enrollment_id: c.row.id,
          student_id: c.row.student_id,
          name: c.row.student_name,
          from: `${c.row.grade} · ${c.row.section}`,
          to: c.target ? `${c.target.grade} · ${c.target.section}` : '—',
          outcome: c.outcome,
          roll_number: c.roll_number,
        })),
        activation_on: plan.activation_on,
      },
    };
  }
  const signature = (a: Actor, plan: PromotionPlan, expires: string, snap: string) =>
    createHmac('sha256', secret)
      .update(canonical([a.context.schoolId, a.id, plan, expires, snap]))
      .digest('hex');
  r.post(
    '/preview',
    asyncRoute(async (req, res) => {
      const a: Actor = res.locals.actor,
        plan = promotionPlanSchema.parse(req.body);
      const result = await transaction(
        pool,
        a.context,
        (tx) => buildPreview(tx, a, plan),
        true,
        'repeatable read',
      );
      const expires = String(Date.now() + 15 * 60 * 1000);
      res.json({
        ...result.preview,
        token: `${expires}.${result.snap}.${signature(a, plan, expires, result.snap)}`,
      });
    }),
  );
  r.post(
    '/activate',
    asyncRoute(async (req, res) => {
      const a: Actor = res.locals.actor,
        b = z
          .object({
            plan: promotionPlanSchema,
            token: z.string().max(300),
            confirmation: z.literal('ACTIVATE'),
          })
          .strict()
          .parse(req.body);
      res.json(
        await transaction(pool, a.context, async (tx) => {
          await writable(tx, a);
          const sid = a.context.schoolId;
          await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
            sid + ':academic-promotion',
          ]);
          const run = (
            await tx.query(
              'SELECT * FROM academic_promotions WHERE school_id=$1 AND id=$2 FOR UPDATE',
              [sid, b.plan.promotion_id],
            )
          ).rows[0];
          if (!run) throw notFound();
          if (run.status === 'COMPLETED') {
            if (canonical(run.plan) !== canonical(b.plan))
              throw fail('This year was already promoted using another plan.');
            return run.result;
          }
          // Parent-year locks serialize every enrollment/academic write via the trigger.
          for (const id of [run.source_session_id, run.target_session_id].sort())
            await year(tx, sid, id, true);
          await tx.query(
            'SELECT s.id FROM students s WHERE s.school_id=$1 AND EXISTS(SELECT FROM enrollments e WHERE e.school_id=s.school_id AND e.student_id=s.id AND e.academic_session_id IN($2,$3)) ORDER BY s.id FOR UPDATE',
            [sid, run.source_session_id, run.target_session_id],
          );
          await tx.query(
            'SELECT f.id FROM fee_records f WHERE f.school_id=$1 AND EXISTS(SELECT FROM enrollments e WHERE e.school_id=f.school_id AND e.student_id=f.student_id AND e.academic_session_id IN($2,$3)) ORDER BY f.id FOR UPDATE',
            [sid, run.source_session_id, run.target_session_id],
          );
          await tx.query('SELECT id FROM teachers WHERE school_id=$1 ORDER BY id FOR SHARE', [sid]);
          await tx.query('SELECT id FROM schools WHERE id=$1 FOR SHARE', [sid]);
          const [expires, snap, seal] = b.token.split('.');
          const expected = signature(a, b.plan, expires || '', snap || '');
          if (
            !expires ||
            !/^\d+$/.test(expires) ||
            Number(expires) < Date.now() ||
            Number(expires) > Date.now() + 16 * 60 * 1000 ||
            !seal ||
            !/^[a-f0-9]{64}$/.test(seal) ||
            !/^[a-f0-9]{64}$/.test(snap || '') ||
            seal.length !== expected.length ||
            !timingSafeEqual(Buffer.from(seal), Buffer.from(expected))
          )
            throw fail('This confirmation has expired or is invalid. Preview the promotion again.');
          const current = await buildPreview(tx, a, b.plan);
          if (current.snap !== snap)
            throw fail(
              'School records changed after the preview. Preview again before activating.',
            );
          if (current.preview.blockers.length) throw fail(current.preview.blockers.join(' '));
          const records = current.choices.map((c) => ({
            id: c.row.id,
            student_id: c.row.student_id,
            target_class_id: c.target?.id || null,
            outcome: c.outcome,
            roll_number: c.roll_number,
          }));
          await tx.query(
            `UPDATE enrollments e SET status='ENDED',ends_on=least(coalesce(e.ends_on,$3::date),$3::date) WHERE e.school_id=$1 AND e.academic_session_id=$2 AND e.status='ACTIVE'`,
            [sid, run.source_session_id, current.source.ends_on],
          );
          await tx.query(
            `INSERT INTO enrollments(school_id,student_id,class_id,academic_session_id,roll_number,starts_on,ends_on,status) SELECT $1,x.student_id,x.target_class_id,$2,x.roll_number,$3::date,$4::date,'ACTIVE' FROM jsonb_to_recordset($5::jsonb) x(student_id uuid,target_class_id uuid,roll_number text,outcome text) WHERE x.outcome IN('PROMOTE','REPEAT')`,
            [
              sid,
              run.target_session_id,
              b.plan.activation_on,
              current.target.ends_on,
              JSON.stringify(records),
            ],
          );
          // Leaving outcomes belong to this transition, not to the identity.
          // Retain account/profile status and family access to old fees/history.
          let feesCreated = 0;
          for (const [class_id, structure_id] of current.selectedFees) {
            const eligible = current.choices
              .filter((c) => c.target?.id === class_id && ['PROMOTE', 'REPEAT'].includes(c.outcome))
              .map((c) => c.row.student_id);
            const assessed = (await assessClassFees(
              tx,
              a,
              { class_id, structure_id },
              false,
              undefined,
              eligible,
            )) as {
              created: number;
            };
            feesCreated += assessed.created;
          }
          await tx.query(
            'UPDATE academic_sessions SET is_current=false,closed_at=now() WHERE school_id=$1 AND id=$2',
            [sid, run.source_session_id],
          );
          await tx.query(
            'UPDATE academic_sessions SET is_current=true WHERE school_id=$1 AND id=$2',
            [sid, run.target_session_id],
          );
          const result = {
            promotion_id: run.id,
            source_session_id: run.source_session_id,
            target_session_id: run.target_session_id,
            counts: current.preview.counts,
            fees_created: feesCreated,
            completed_at: new Date().toISOString(),
          };
          await tx.query(
            "UPDATE academic_promotions SET status='COMPLETED',plan=$3,result=$4,completed_by=$5,completed_at=now() WHERE school_id=$1 AND id=$2",
            [sid, run.id, b.plan, result, a.id],
          );
          await audit(tx, sid, a.id, 'academic_year.activated', 'academic_promotions', run.id);
          return result;
        }),
      );
    }),
  );
  return r;
}
