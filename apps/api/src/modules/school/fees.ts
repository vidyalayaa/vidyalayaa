import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import {
  feeAssessmentSchema,
  feeDate,
  feeCollectionSchema,
  feeStructureSchema,
  feeReasonSchema,
  transportRouteSchema,
  transportAssignmentSchema,
  feeInstallments,
  uuid,
  type FeeCollectionInput,
} from '@vidyalayaa/contracts';
import { transaction, type Tx } from '../../lib/db.js';
import { ApiError, asyncRoute, notFound } from '../../lib/errors.js';
import { paged } from '../../lib/pagination.js';
import { hash } from '../../lib/crypto.js';
import type { Actor } from '../../middleware/auth.js';

interface Controls {
  requireWrite: (tx: Tx, a: Actor) => Promise<void>;
  withIdempotency: <T>(
    tx: Tx,
    a: Actor,
    key: string | undefined,
    body: unknown,
    fn: () => Promise<T>,
  ) => Promise<T>;
}
const cents = (v: unknown) => Math.round(Number(v) * 100),
  money = (v: number) => (v / 100).toFixed(2);
const iso = (v: unknown) =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
const keyRequired = (key: string | undefined) => {
  if (!key || !/^[a-zA-Z0-9:_-]{8,200}$/.test(key))
    throw new ApiError(
      422,
      'IDEMPOTENCY_KEY_REQUIRED',
      'An 8–200 character payment retry key is required.',
    );
  return key;
};
function installmentDates(...args: Parameters<typeof feeInstallments>) {
  try {
    return feeInstallments(...args);
  } catch (e) {
    if (e instanceof RangeError) throw new ApiError(422, 'FEE_SCHEDULE_TOO_LONG', e.message);
    throw e;
  }
}
export async function collectFeePayment(tx: Tx, a: Actor, b: FeeCollectionInput, key: string) {
  keyRequired(key);
  if (!['school_admin', 'finance_staff'].includes(a.active!.role))
    throw new ApiError(403, 'FORBIDDEN', 'Only authorized finance staff can record payments.');
  if (b.receipt_no && a.active!.role !== 'school_admin')
    throw new ApiError(
      403,
      'RECEIPT_OVERRIDE_FORBIDDEN',
      'Only School Admin can supply a receipt number. Correct an issued receipt by reversing and replacing its payment.',
    );
  const sid = a.context.schoolId,
    fingerprint = hash(JSON.stringify(b));
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    sid + ':fee-payment:' + a.id + ':' + key,
  ]);
  const previous = (
    await tx.query(
      'SELECT id,request_hash,receipt_snapshot FROM fee_payments WHERE school_id=$1 AND recorded_by=$2 AND idempotency_key=$3',
      [sid, a.id, key],
    )
  ).rows[0];
  if (previous) {
    if (previous.request_hash !== fingerprint)
      throw new ApiError(
        409,
        'IDEMPOTENCY_CONFLICT',
        'This retry key was used for different payment details.',
      );
    return { id: previous.id, receipt: previous.receipt_snapshot };
  }
  await tx.query('SELECT app.lock_fee_account($1,$2,$3)', [
    sid,
    b.student_id,
    b.academic_session_id,
  ]);
  const identity = (
    await tx.query(
      `SELECT sc.name AS school_name,concat_ws(' ',s.first_name,s.last_name) AS student_name,s.student_code,ac.name AS academic_year,(now() AT TIME ZONE sc.timezone)::date::text AS today
    FROM students s JOIN schools sc ON sc.id=s.school_id JOIN academic_sessions ac ON ac.school_id=s.school_id AND ac.id=$3 WHERE s.school_id=$1 AND s.id=$2`,
      [sid, b.student_id, b.academic_session_id],
    )
  ).rows[0];
  if (!identity) throw notFound();
  if (b.payment_date > iso(identity.today))
    throw new ApiError(422, 'PAYMENT_DATE_INVALID', 'Payment date cannot be in the future.');
  const fees = (
    await tx.query(
      'SELECT *,due_on::text AS due_on FROM fee_records WHERE school_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',
      [sid, b.allocations.map((x) => x.fee_id)],
    )
  ).rows;
  if (fees.length !== b.allocations.length) throw notFound();
  const currency = fees[0].currency;
  for (const row of fees) {
    if (
      row.student_id !== b.student_id ||
      row.academic_session_id !== b.academic_session_id ||
      row.currency !== currency
    )
      throw new ApiError(
        422,
        'FEE_ALLOCATION_INVALID',
        'All installments must belong to this student, academic year and currency.',
      );
    if (row.status === 'WAIVED' || row.voided_at || cents(row.amount_due) <= cents(row.amount_paid))
      throw new ApiError(409, 'FEE_SETTLED', 'A selected installment has no outstanding balance.');
    if (
      cents(b.allocations.find((x) => x.fee_id === row.id)!.amount) >
      cents(row.amount_due) - cents(row.amount_paid)
    )
      throw new ApiError(
        409,
        'PAYMENT_EXCEEDS_BALANCE',
        'The payment exceeds an installment balance. Refresh the statement.',
      );
  }
  const total = b.allocations.reduce((s, v) => s + cents(v.amount), 0),
    id = crypto.randomUUID(),
    receiptNo = b.receipt_no || 'REC-' + id;
  const balance = (
    await tx.query(
      "SELECT (coalesce(sum(amount_due-amount_paid),0)-$5::numeric)::text AS balance FROM fee_records WHERE school_id=$1 AND student_id=$2 AND academic_session_id=$3 AND currency=$4 AND status<>'WAIVED' AND voided_at IS NULL",
      [sid, b.student_id, b.academic_session_id, currency, money(total)],
    )
  ).rows[0];
  const enrollment = (
    await tx.query(
      `SELECT concat('Class ',c.grade,' · Section ',c.section) AS class_label,e.roll_number FROM enrollments e JOIN classes c ON c.school_id=e.school_id AND c.id=e.class_id WHERE e.school_id=$1 AND e.student_id=$2 AND e.academic_session_id=$3 ORDER BY (e.class_id=ANY($4::uuid[])) DESC,e.starts_on DESC,e.id LIMIT 1`,
      [sid, b.student_id, b.academic_session_id, fees.map((f) => f.class_id).filter(Boolean)],
    )
  ).rows[0];
  const receipt = {
    ...identity,
    today: undefined,
    roll_number: enrollment?.roll_number || null,
    class_label: enrollment?.class_label || null,
    receipt_no: receiptNo,
    payment_date: b.payment_date,
    payment_method: b.payment_method,
    reference: b.reference,
    note: b.note,
    recorded_by: a.full_name,
    currency,
    amount: money(total),
    balance_after: balance.balance as string,
    lines: b.allocations.map((x) => {
      const f = fees.find((f) => f.id === x.fee_id)!;
      return {
        label: f.fee_type,
        installment: f.installment_label || iso(f.due_on),
        amount: money(cents(x.amount)),
      };
    }),
  };
  await tx.query(
    `INSERT INTO fee_payments(id,school_id,student_id,academic_session_id,receipt_no,payment_date,amount,currency,payment_method,reference,note,recorded_by,receipt_snapshot,idempotency_key,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      id,
      sid,
      b.student_id,
      b.academic_session_id,
      receiptNo,
      b.payment_date,
      money(total),
      currency,
      b.payment_method,
      b.reference,
      b.note,
      a.id,
      receipt,
      key,
      fingerprint,
    ],
  );
  for (const x of b.allocations)
    await tx.query(
      'INSERT INTO fee_payment_allocations(school_id,payment_id,fee_id,amount) VALUES($1,$2,$3,$4)',
      [sid, id, x.fee_id, x.amount],
    );
  return { id, receipt };
}
const assessmentSelect = `f.*,f.due_on::text AS due_on,concat_ws(' ',s.first_name,s.last_name)||' · '||s.student_code AS student_label,
  CASE WHEN c.id IS NULL THEN NULL ELSE concat('Class ',c.grade,' · Section ',c.section) END AS class_label`;
const effectiveClass = `coalesce(f.class_id,(SELECT e.class_id FROM enrollments e WHERE e.school_id=f.school_id AND e.student_id=f.student_id AND e.academic_session_id=f.academic_session_id AND f.due_on>=e.starts_on AND (e.ends_on IS NULL OR f.due_on<=e.ends_on) ORDER BY e.starts_on DESC,e.id LIMIT 1))`;
const assessmentJoins = ` FROM fee_records f JOIN students s ON s.school_id=f.school_id AND s.id=f.student_id LEFT JOIN classes c ON c.school_id=f.school_id AND c.id=${effectiveClass}`;
const summarySql = `SELECT f.currency,coalesce(sum(f.amount_due) FILTER(WHERE f.status<>'WAIVED' AND f.voided_at IS NULL),0)::text AS expected,
coalesce(sum(f.amount_paid) FILTER(WHERE f.voided_at IS NULL),0)::text AS collected,
coalesce(sum(f.amount_due-f.amount_paid) FILTER(WHERE f.status<>'WAIVED' AND f.voided_at IS NULL),0)::text AS outstanding,
coalesce(sum(f.amount_due-f.amount_paid) FILTER(WHERE f.status<>'WAIVED' AND f.voided_at IS NULL AND f.due_on<(now() AT TIME ZONE (SELECT timezone FROM schools WHERE id=f.school_id))::date),0)::text AS overdue,
coalesce(sum(f.amount_due) FILTER(WHERE f.category='TRANSPORT' AND f.status<>'WAIVED' AND f.voided_at IS NULL),0)::text AS transport_expected,
coalesce(sum(f.amount_paid) FILTER(WHERE f.category='TRANSPORT' AND f.voided_at IS NULL),0)::text AS transport_paid,
coalesce(sum(f.amount_due-f.amount_paid) FILTER(WHERE f.category='TRANSPORT' AND f.status<>'WAIVED' AND f.voided_at IS NULL),0)::text AS transport_outstanding`;
const paymentSelect = `p.*,p.payment_date::text AS payment_date,u.full_name AS recorded_by_label,r.created_at AS reversed_at,r.reason AS reversal_reason`;
const paymentJoins = ` FROM fee_payments p LEFT JOIN users u ON u.id=p.recorded_by LEFT JOIN fee_payment_reversals r ON r.school_id=p.school_id AND r.payment_id=p.id`;
function filters(q: Record<string, unknown>, sid: string) {
  const schema = z.object({
    academic_session_id: uuid.optional(),
    grade: z.string().max(80).optional(),
    class_id: uuid.optional(),
    student_id: uuid.optional(),
    category: z
      .enum(['TUITION', 'ADMISSION', 'EXAMINATION', 'ANNUAL', 'OTHER', 'TRANSPORT'])
      .optional(),
    search: z.string().trim().max(200).optional(),
    from: feeDate.optional(),
    to: feeDate.optional(),
  });
  const b = schema.parse(q),
    values: unknown[] = [sid],
    parts = ['f.school_id=$1'];
  const add = (sql: string, v: unknown) => {
    values.push(v);
    parts.push(sql.replaceAll('?', `$${values.length}`));
  };
  if (b.academic_session_id) add('f.academic_session_id=?', b.academic_session_id);
  if (b.student_id) add('f.student_id=?', b.student_id);
  if (b.class_id) add('c.id=?', b.class_id);
  if (b.grade) add('c.grade=?', b.grade);
  if (b.category) add('f.category=?', b.category);
  if (b.search)
    add(
      `(concat_ws(' ',s.first_name,s.last_name,s.student_code,c.grade,c.section,f.fee_type) ILIKE ? OR EXISTS(SELECT FROM fee_payment_allocations al JOIN fee_payments p ON p.school_id=al.school_id AND p.id=al.payment_id WHERE al.school_id=f.school_id AND al.fee_id=f.id AND p.receipt_no ILIKE ?))`,
      '%' + b.search + '%',
    );
  return { b, values, where: parts.join(' AND ') };
}
export function feesRouter(pool: pg.Pool, controls: Controls) {
  const r = Router();
  r.use((_req, res, next) => {
    if (!res.locals.actor.active?.permissions.includes('fees.read'))
      return next(new ApiError(403, 'FORBIDDEN', 'Fee access is required.'));
    next();
  });
  r.get(
    '/options',
    asyncRoute(async (_req, res) => {
      const a = res.locals.actor;
      res.json(
        await transaction(
          pool,
          a.context,
          async (tx) => ({
            sessions: (
              await tx.query(
                'SELECT id,name,starts_on::text,ends_on::text,is_current FROM academic_sessions WHERE school_id=$1 ORDER BY starts_on DESC,id',
                [a.context.schoolId],
              )
            ).rows,
            classes: (
              await tx.query(
                `SELECT c.id,c.grade,c.section,c.academic_session_id FROM classes c WHERE c.school_id=$1 AND c.retired_at IS NULL AND (app.school_role(c.school_id) IN ('school_admin','finance_staff','principal') OR EXISTS(SELECT FROM enrollments e WHERE e.school_id=c.school_id AND e.class_id=c.id AND app.fee_student_visible(e.school_id,e.student_id))) ORDER BY c.grade,c.section,c.id`,
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
    '/students',
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        b = z
          .object({
            academic_session_id: uuid,
            class_id: uuid.optional(),
            grade: z.string().max(80).optional(),
          })
          .parse(req.query),
        search = z.string().max(200).optional().parse(req.query.search);
      res.json(
        await transaction(
          pool,
          a.context,
          (tx) =>
            paged(
              tx,
              `SELECT s.id,concat_ws(' ',s.first_name,s.last_name) AS name,s.student_code FROM students s WHERE s.school_id=$1 AND app.fee_student_visible(s.school_id,s.id) AND (EXISTS(SELECT FROM enrollments e WHERE e.school_id=s.school_id AND e.student_id=s.id AND e.academic_session_id=$2 AND ($3::uuid IS NULL OR e.class_id=$3)) OR ($3::uuid IS NULL AND EXISTS(SELECT FROM fee_records f WHERE f.school_id=s.school_id AND f.student_id=s.id AND f.academic_session_id=$2))) AND ($4::text IS NULL OR concat_ws(' ',s.first_name,s.last_name,s.student_code) ILIKE $4) AND ($5::text IS NULL OR EXISTS(SELECT FROM enrollments ge JOIN classes gc ON gc.school_id=ge.school_id AND gc.id=ge.class_id WHERE ge.school_id=s.school_id AND ge.student_id=s.id AND ge.academic_session_id=$2 AND gc.grade=$5)) ORDER BY s.first_name,s.last_name,s.id`,
              [
                a.context.schoolId,
                b.academic_session_id,
                b.class_id || null,
                search ? '%' + search + '%' : null,
                b.grade || null,
              ],
              req.query,
            ),
          true,
        ),
      );
    }),
  );
  r.get(
    '/students/:id',
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        id = uuid.parse(req.params.id),
        year = uuid.parse(req.query.academic_session_id);
      res.json(
        await transaction(
          pool,
          a.context,
          async (tx) => {
            const student = (
              await tx.query(
                "SELECT id,concat_ws(' ',first_name,last_name) AS name,student_code FROM students WHERE school_id=$1 AND id=$2 AND app.fee_student_visible(school_id,id)",
                [a.context.schoolId, id],
              )
            ).rows[0];
            if (!student) throw notFound();
            const v = [a.context.schoolId, id, year],
              where = 'f.school_id=$1 AND f.student_id=$2 AND f.academic_session_id=$3';
            return {
              student,
              assessments: (
                await tx.query(
                  `SELECT ${assessmentSelect}${assessmentJoins} WHERE ${where} ORDER BY f.due_on,f.fee_type,f.id`,
                  v,
                )
              ).rows,
              summary: (
                await tx.query(
                  `${summarySql} FROM fee_records f WHERE ${where} GROUP BY currency ORDER BY currency`,
                  v,
                )
              ).rows,
              payments: (
                await tx.query(
                  `SELECT ${paymentSelect}${paymentJoins} WHERE p.school_id=$1 AND p.student_id=$2 AND p.academic_session_id=$3 ORDER BY p.payment_date DESC,p.created_at DESC,p.id`,
                  v,
                )
              ).rows,
              transport: (
                await tx.query(
                  'SELECT ta.*,ta.starts_on::text AS starts_on,ta.ends_on::text AS ends_on,ta.first_due_on::text AS first_due_on,ta.ended_on::text AS ended_on,rt.name AS route_name FROM fee_transport_assignments ta JOIN fee_transport_routes rt ON rt.school_id=ta.school_id AND rt.id=ta.route_id WHERE ta.school_id=$1 AND ta.student_id=$2 AND ta.academic_session_id=$3 ORDER BY ta.starts_on DESC',
                  v,
                )
              ).rows,
            };
          },
          true,
        ),
      );
    }),
  );
  r.get(
    '/assessments/:id',
    asyncRoute(async (req, res) => {
      const a = res.locals.actor;
      const row = await transaction(
        pool,
        a.context,
        async (tx) =>
          (
            await tx.query(
              `SELECT ${assessmentSelect}${assessmentJoins} WHERE f.school_id=$1 AND f.id=$2`,
              [a.context.schoolId, uuid.parse(req.params.id)],
            )
          ).rows[0],
        true,
      );
      if (!row) throw notFound();
      res.json(row);
    }),
  );
  r.get(
    '/payments/:id',
    asyncRoute(async (req, res) => {
      const a = res.locals.actor;
      const row = await transaction(
        pool,
        a.context,
        async (tx) =>
          (
            await tx.query(
              `SELECT ${paymentSelect}${paymentJoins} WHERE p.school_id=$1 AND p.id=$2`,
              [a.context.schoolId, uuid.parse(req.params.id)],
            )
          ).rows[0],
        true,
      );
      if (!row) throw notFound();
      res.json(row);
    }),
  );
  r.get(
    '/structures',
    asyncRoute(async (req, res) => {
      const a = res.locals.actor;
      if (!['school_admin', 'finance_staff', 'principal'].includes(a.active!.role))
        throw new ApiError(403, 'FORBIDDEN', 'Fee configuration is restricted to school staff.');
      res.json(
        await transaction(
          pool,
          a.context,
          (tx) =>
            paged(
              tx,
              `SELECT st.*,(SELECT coalesce(jsonb_agg(it ORDER BY it.category,it.label,it.id),'[]'::jsonb) FROM fee_structure_items it WHERE it.school_id=st.school_id AND it.structure_id=st.id) AS items,(SELECT jsonb_agg(class_id ORDER BY class_id) FROM fee_structure_sections sec WHERE sec.school_id=st.school_id AND sec.structure_id=st.id) AS class_ids FROM fee_structures st WHERE st.school_id=$1 AND st.academic_session_id=$2 AND st.grade=$3 ORDER BY st.version DESC,st.id`,
              [
                a.context.schoolId,
                uuid.parse(req.query.academic_session_id),
                z.string().min(1).max(80).parse(req.query.grade),
              ],
              req.query,
            ),
          true,
        ),
      );
    }),
  );
  r.get(
    '/routes',
    asyncRoute(async (_req, res) => {
      const a = res.locals.actor;
      if (!['school_admin', 'finance_staff', 'principal'].includes(a.active!.role))
        throw new ApiError(403, 'FORBIDDEN', 'Route configuration is restricted to school staff.');
      res.json(
        await transaction(
          pool,
          a.context,
          async (tx) => ({
            data: (
              await tx.query(
                'SELECT * FROM fee_transport_routes WHERE school_id=$1 ORDER BY name,id',
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
    '/reports',
    asyncRoute(async (req, res) => {
      const a = res.locals.actor;
      if (!['school_admin', 'finance_staff', 'principal'].includes(a.active!.role))
        throw new ApiError(
          403,
          'FORBIDDEN',
          'School fee reports are restricted to authorized staff.',
        );
      const f = filters(req.query, a.context.schoolId);
      res.json(
        await transaction(
          pool,
          a.context,
          async (tx) => {
            const dateValues = [...f.values, f.b.from || '0001-01-01', f.b.to || '9999-12-31'];
            const collections = await tx.query(
              `SELECT p.currency,f.category,p.payment_date::text,count(DISTINCT p.id)::int AS receipts,sum(al.amount)::text AS collected FROM fee_payment_allocations al JOIN fee_payments p ON p.school_id=al.school_id AND p.id=al.payment_id JOIN fee_records f ON f.school_id=al.school_id AND f.id=al.fee_id JOIN students s ON s.school_id=f.school_id AND s.id=f.student_id LEFT JOIN classes c ON c.school_id=f.school_id AND c.id=${effectiveClass} WHERE ${f.where} AND p.kind='PAYMENT' AND NOT EXISTS(SELECT FROM fee_payment_reversals rev WHERE rev.school_id=p.school_id AND rev.payment_id=p.id) AND p.payment_date BETWEEN $${f.values.length + 1}::date AND $${f.values.length + 2}::date GROUP BY p.currency,f.category,p.payment_date ORDER BY p.payment_date DESC,f.category`,
              dateValues,
            );
            return {
              summary: (
                await tx.query(
                  `${summarySql}${assessmentJoins} WHERE ${f.where} GROUP BY currency ORDER BY currency`,
                  f.values,
                )
              ).rows,
              collections: collections.rows,
              records: await paged(
                tx,
                `SELECT ${assessmentSelect}${assessmentJoins} WHERE ${f.where} ORDER BY f.due_on,f.id`,
                f.values,
                req.query,
              ),
            };
          },
          true,
        ),
      );
    }),
  );
  r.get(
    '/reports/export',
    asyncRoute(async (req, res) => {
      const a = res.locals.actor;
      if (!['school_admin', 'finance_staff', 'principal'].includes(a.active!.role))
        throw new ApiError(
          403,
          'FORBIDDEN',
          'School fee exports are restricted to authorized staff.',
        );
      const f = filters(req.query, a.context.schoolId);
      const rows = await transaction(
        pool,
        a.context,
        async (tx) => {
          const result = await tx.query(
            `SELECT s.student_code,concat_ws(' ',s.first_name,s.last_name) AS student,c.grade,c.section,f.fee_type,f.category,f.installment_label,f.due_on::text AS due_on,f.currency,f.amount_due,f.amount_paid,f.status,p.receipt_no,p.payment_date::text AS payment_date,p.payment_method,p.reference,p.note,rev.reason AS reversal_reason,f.voided_at,f.void_reason,al.amount AS receipt_allocation,rev.created_at AS reversed_at,p.kind,u.full_name AS recorded_by FROM fee_records f JOIN students s ON s.school_id=f.school_id AND s.id=f.student_id LEFT JOIN classes c ON c.school_id=f.school_id AND c.id=${effectiveClass} LEFT JOIN fee_payment_allocations al ON al.school_id=f.school_id AND al.fee_id=f.id LEFT JOIN fee_payments p ON p.school_id=al.school_id AND p.id=al.payment_id LEFT JOIN fee_payment_reversals rev ON rev.school_id=p.school_id AND rev.payment_id=p.id LEFT JOIN users u ON u.id=p.recorded_by WHERE ${f.where} AND ($${f.values.length + 1}::date IS NULL OR p.payment_date>=$${f.values.length + 1}::date) AND ($${f.values.length + 2}::date IS NULL OR p.payment_date<=$${f.values.length + 2}::date) ORDER BY s.student_code,f.due_on,f.id,p.created_at LIMIT 10001`,
            [...f.values, f.b.from || null, f.b.to || null],
          );
          if (result.rows.length > 10000)
            throw new ApiError(
              422,
              'EXPORT_TOO_LARGE',
              'Narrow the academic year, class, student or date filters to export at most 10,000 rows.',
            );
          return result.rows;
        },
        true,
      );
      const cols = [
        'student_code',
        'student',
        'grade',
        'section',
        'fee_type',
        'category',
        'installment_label',
        'due_on',
        'currency',
        'amount_due',
        'amount_paid',
        'status',
        'receipt_no',
        'payment_date',
        'payment_method',
        'reference',
        'note',
        'reversal_reason',
        'voided_at',
        'void_reason',
        'receipt_allocation',
        'reversed_at',
        'kind',
        'recorded_by',
      ];
      const cell = (v: unknown) => {
        let s =
          v instanceof Date ? v.toISOString() : v === null || v === undefined ? '' : String(v);
        if (/^[\s]*[=+@-]/.test(s)) s = "'" + s;
        return '"' + s.replaceAll('"', '""') + '"';
      };
      res.json({
        filename: 'vidyalayaa-fees.csv',
        csv:
          '\uFEFF' +
          [
            cols.map(cell).join(','),
            ...rows.map((row) => cols.map((k) => cell(row[k])).join(',')),
          ].join('\r\n'),
      });
    }),
  );
  r.use((_req, res, next) => {
    const a = res.locals.actor;
    if (
      !a.active?.permissions.includes('fees.write') ||
      !['school_admin', 'finance_staff'].includes(a.active.role)
    )
      return next(
        new ApiError(403, 'FORBIDDEN', 'Only School Admin and finance staff can manage fees.'),
      );
    next();
  });
  r.post(
    '/structures',
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        b = feeStructureSchema.parse(req.body);
      res.status(201).json(
        await transaction(pool, a.context, async (tx) => {
          await controls.requireWrite(tx, a);
          await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
            a.context.schoolId + ':fee-structure:' + b.academic_session_id + ':' + b.grade,
          ]);
          return controls.withIdempotency(
            tx,
            a,
            req.header('Idempotency-Key'),
            { op: 'fee.structure', ...b },
            async () => {
              const session = (
                await tx.query(
                  'SELECT *,starts_on::text AS starts_on,ends_on::text AS ends_on FROM academic_sessions WHERE school_id=$1 AND id=$2 AND retired_at IS NULL',
                  [a.context.schoolId, b.academic_session_id],
                )
              ).rows[0];
              if (!session) throw notFound();
              const classes = (
                await tx.query(
                  'SELECT id FROM classes WHERE school_id=$1 AND academic_session_id=$2 AND grade=$3 AND retired_at IS NULL ORDER BY id',
                  [a.context.schoolId, b.academic_session_id, b.grade],
                )
              ).rows;
              if (!classes.length)
                throw new ApiError(
                  422,
                  'FEE_CLASS_REQUIRED',
                  'Configure this class and its sections in Academics first.',
                );
              if (
                (b.mode === 'SECTION' &&
                  classes.some((c) => !b.items.some((i) => i.class_id === c.id))) ||
                b.items.some((i) => i.class_id && !classes.some((c) => c.id === i.class_id))
              )
                throw new ApiError(
                  422,
                  'FEE_SECTION_REQUIRED',
                  'Include fee items for every section of this class.',
                );
              if (
                b.items.some(
                  (i) =>
                    i.first_due_on < iso(session.starts_on) ||
                    i.first_due_on > iso(session.ends_on),
                )
              )
                throw new ApiError(
                  422,
                  'FEE_DATE_INVALID',
                  'Installment dates must be inside the academic year.',
                );
              const latest = (
                await tx.query(
                  'SELECT coalesce(max(version),0)::int AS version FROM fee_structures WHERE school_id=$1 AND academic_session_id=$2 AND grade=$3',
                  [a.context.schoolId, b.academic_session_id, b.grade],
                )
              ).rows[0].version;
              if (latest !== b.expected_version)
                throw new ApiError(
                  409,
                  'FEE_VERSION_CONFLICT',
                  'The fee structure changed. Reload before saving a new version.',
                );
              const st = (
                await tx.query(
                  'INSERT INTO fee_structures(school_id,academic_session_id,grade,mode,version,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
                  [a.context.schoolId, b.academic_session_id, b.grade, b.mode, latest + 1, a.id],
                )
              ).rows[0];
              for (const c of classes)
                await tx.query(
                  'INSERT INTO fee_structure_sections(school_id,structure_id,class_id) VALUES($1,$2,$3)',
                  [a.context.schoolId, st.id, c.id],
                );
              for (const i of b.items)
                await tx.query(
                  'INSERT INTO fee_structure_items(school_id,structure_id,class_id,category,label,amount,frequency,first_due_on) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
                  [
                    a.context.schoolId,
                    st.id,
                    i.class_id,
                    i.category,
                    i.label,
                    i.amount,
                    i.frequency,
                    i.first_due_on,
                  ],
                );
              return st;
            },
          );
        }),
      );
    }),
  );
  r.post(
    '/assessments/preview',
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        b = feeAssessmentSchema.parse(req.body);
      res.json(await transaction(pool, a.context, (tx) => assessClassFees(tx, a, b, true), true));
    }),
  );
  r.post(
    '/assessments',
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        b = feeAssessmentSchema.parse(req.body);
      res.json(
        await transaction(pool, a.context, async (tx) => {
          await controls.requireWrite(tx, a);
          return controls.withIdempotency(
            tx,
            a,
            req.header('Idempotency-Key'),
            { op: 'fee.assess', ...b },
            () => assessClassFees(tx, a, b, false),
          );
        }),
      );
    }),
  );
  r.post(
    '/assessments/:id/void',
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        b = feeReasonSchema.parse(req.body);
      res.json(
        await transaction(pool, a.context, async (tx) => {
          await controls.requireWrite(tx, a);
          const identity = (
            await tx.query(
              'SELECT student_id,academic_session_id FROM fee_records WHERE school_id=$1 AND id=$2',
              [a.context.schoolId, uuid.parse(req.params.id)],
            )
          ).rows[0];
          if (!identity) throw notFound();
          await tx.query('SELECT app.lock_fee_account($1,$2,$3)', [
            a.context.schoolId,
            identity.student_id,
            identity.academic_session_id,
          ]);
          const f = (
            await tx.query('SELECT * FROM fee_records WHERE school_id=$1 AND id=$2 FOR UPDATE', [
              a.context.schoolId,
              uuid.parse(req.params.id),
            ])
          ).rows[0];
          if (!f) throw notFound();
          if (cents(f.amount_paid) > 0)
            throw new ApiError(
              409,
              'FEE_HAS_PAYMENTS',
              'Reverse associated payments before voiding this assessment.',
            );
          if (f.voided_at) return f;
          return (
            await tx.query(
              "UPDATE fee_records SET voided_at=now(),void_reason=$3,status='WAIVED' WHERE school_id=$1 AND id=$2 RETURNING *",
              [a.context.schoolId, f.id, b.reason],
            )
          ).rows[0];
        }),
      );
    }),
  );
  r.post(
    '/payments',
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        b = feeCollectionSchema.parse(req.body),
        key = keyRequired(req.header('Idempotency-Key'));
      res.status(201).json(
        await transaction(pool, a.context, async (tx) => {
          await controls.requireWrite(tx, a);
          return collectFeePayment(tx, a, b, key);
        }),
      );
    }),
  );
  r.post(
    '/payments/:id/reverse',
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        b = feeReasonSchema.parse(req.body),
        id = uuid.parse(req.params.id);
      res.json(
        await transaction(pool, a.context, async (tx) => {
          await controls.requireWrite(tx, a);
          return controls.withIdempotency(
            tx,
            a,
            keyRequired(req.header('Idempotency-Key')),
            { op: 'fee.reverse', id, ...b },
            async () => {
              const identity = (
                await tx.query(
                  'SELECT student_id,academic_session_id FROM fee_payments WHERE school_id=$1 AND id=$2',
                  [a.context.schoolId, id],
                )
              ).rows[0];
              if (!identity) throw notFound();
              await tx.query('SELECT app.lock_fee_account($1,$2,$3)', [
                a.context.schoolId,
                identity.student_id,
                identity.academic_session_id,
              ]);
              await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
                a.context.schoolId + ':fee-ledger:' + id,
              ]);
              if (
                !(
                  await tx.query('SELECT id FROM fee_payments WHERE school_id=$1 AND id=$2', [
                    a.context.schoolId,
                    id,
                  ])
                ).rowCount
              )
                throw notFound();
              if (
                (
                  await tx.query(
                    'SELECT id FROM fee_payment_reversals WHERE school_id=$1 AND payment_id=$2',
                    [a.context.schoolId, id],
                  )
                ).rowCount
              )
                throw new ApiError(
                  409,
                  'PAYMENT_ALREADY_REVERSED',
                  'This payment was already reversed. Its original receipt is retained.',
                );
              return (
                await tx.query(
                  'INSERT INTO fee_payment_reversals(school_id,payment_id,reason,recorded_by) VALUES($1,$2,$3,$4) RETURNING *',
                  [a.context.schoolId, id, b.reason, a.id],
                )
              ).rows[0];
            },
          );
        }),
      );
    }),
  );
  r.post(
    '/routes',
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        b = transportRouteSchema.parse(req.body);
      res.status(201).json(
        await transaction(pool, a.context, async (tx) => {
          await controls.requireWrite(tx, a);
          return controls.withIdempotency(
            tx,
            a,
            req.header('Idempotency-Key'),
            { op: 'fee.route', ...b },
            async () =>
              (
                await tx.query(
                  'INSERT INTO fee_transport_routes(school_id,name,description,active) VALUES($1,$2,$3,$4) RETURNING *',
                  [a.context.schoolId, b.name, b.description, b.active],
                )
              ).rows[0],
          );
        }),
      );
    }),
  );
  r.patch(
    '/routes/:id',
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        b = transportRouteSchema.parse(req.body);
      const row = await transaction(pool, a.context, async (tx) => {
        await controls.requireWrite(tx, a);
        return (
          await tx.query(
            'UPDATE fee_transport_routes SET name=$3,description=$4,active=$5 WHERE school_id=$1 AND id=$2 RETURNING *',
            [a.context.schoolId, uuid.parse(req.params.id), b.name, b.description, b.active],
          )
        ).rows[0];
      });
      if (!row) throw notFound();
      res.json(row);
    }),
  );
  r.post(
    '/transport',
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        b = transportAssignmentSchema.parse(req.body);
      res.status(201).json(
        await transaction(pool, a.context, async (tx) => {
          await controls.requireWrite(tx, a);
          return controls.withIdempotency(
            tx,
            a,
            keyRequired(req.header('Idempotency-Key')),
            { op: 'fee.transport', ...b },
            async () => {
              await tx.query('SELECT app.lock_fee_account($1,$2,$3)', [
                a.context.schoolId,
                b.student_id,
                b.academic_session_id,
              ]);
              const row = (
                await tx.query(
                  'INSERT INTO fee_transport_assignments(school_id,student_id,academic_session_id,route_id,amount,frequency,starts_on,ends_on,first_due_on,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
                  [
                    a.context.schoolId,
                    b.student_id,
                    b.academic_session_id,
                    b.route_id,
                    b.amount,
                    b.frequency,
                    b.starts_on,
                    b.ends_on,
                    b.first_due_on,
                    a.id,
                  ],
                )
              ).rows[0];
              const route = (
                await tx.query(
                  'SELECT name FROM fee_transport_routes WHERE school_id=$1 AND id=$2',
                  [a.context.schoolId, b.route_id],
                )
              ).rows[0];
              const dates = installmentDates(b.first_due_on, b.ends_on, b.frequency);
              for (const [n, due] of dates.entries())
                await tx.query(
                  "INSERT INTO fee_records(school_id,student_id,academic_session_id,transport_assignment_id,category,fee_type,installment_label,amount_due,due_on,status,assessment_key) VALUES($1,$2,$3,$4,'TRANSPORT',$5,$6,$7,$8,'UNPAID',$9)",
                  [
                    a.context.schoolId,
                    b.student_id,
                    b.academic_session_id,
                    row.id,
                    'Transport · ' + route.name,
                    'Transport · ' + (n + 1) + ' · ' + due,
                    b.amount,
                    due,
                    'TRANSPORT:' + b.student_id + ':' + b.academic_session_id + ':' + due,
                  ],
                );
              return row;
            },
          );
        }),
      );
    }),
  );
  r.post(
    '/transport/:id/end',
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        b = feeReasonSchema.extend({ ended_on: feeDate }).parse(req.body);
      res.json(
        await transaction(pool, a.context, async (tx) => {
          await controls.requireWrite(tx, a);
          const identity = (
            await tx.query(
              'SELECT student_id,academic_session_id FROM fee_transport_assignments WHERE school_id=$1 AND id=$2',
              [a.context.schoolId, uuid.parse(req.params.id)],
            )
          ).rows[0];
          if (!identity) throw notFound();
          await tx.query('SELECT app.lock_fee_account($1,$2,$3)', [
            a.context.schoolId,
            identity.student_id,
            identity.academic_session_id,
          ]);
          const ta = (
            await tx.query(
              'SELECT * FROM fee_transport_assignments WHERE school_id=$1 AND id=$2 FOR UPDATE',
              [a.context.schoolId, uuid.parse(req.params.id)],
            )
          ).rows[0];
          if (!ta) throw notFound();
          if (ta.ended_on)
            throw new ApiError(
              409,
              'TRANSPORT_ALREADY_ENDED',
              'This transport assignment has already ended.',
            );
          const future = (
            await tx.query(
              'SELECT * FROM fee_records WHERE school_id=$1 AND transport_assignment_id=$2 AND due_on>$3::date AND voided_at IS NULL ORDER BY id FOR UPDATE',
              [a.context.schoolId, ta.id, b.ended_on],
            )
          ).rows;
          if (future.some((f) => cents(f.amount_paid) > 0))
            throw new ApiError(
              409,
              'TRANSPORT_HAS_PAYMENTS',
              'Reverse payments on future transport installments before ending this service.',
            );
          await tx.query(
            "UPDATE fee_records SET voided_at=now(),void_reason=$3,status='WAIVED' WHERE school_id=$1 AND transport_assignment_id=$2 AND due_on>$4::date AND voided_at IS NULL",
            [a.context.schoolId, ta.id, b.reason, b.ended_on],
          );
          return (
            await tx.query(
              'UPDATE fee_transport_assignments SET ended_on=$3,end_reason=$4 WHERE school_id=$1 AND id=$2 RETURNING *',
              [a.context.schoolId, ta.id, b.ended_on, b.reason],
            )
          ).rows[0];
        }),
      );
    }),
  );
  return r;
}

export async function assessClassFees(
  tx: Tx,
  a: Actor,
  b: z.infer<typeof feeAssessmentSchema>,
  preview: boolean,
  roster?: { student_id: string; starts_on: string; ends_on: string | null }[],
  studentIds?: string[],
) {
  const sid = a.context.schoolId,
    st = (
      await tx.query(
        'SELECT st.*,ac.ends_on::text AS ends_on FROM fee_structures st JOIN academic_sessions ac ON ac.school_id=st.school_id AND ac.id=st.academic_session_id JOIN fee_structure_sections sec ON sec.school_id=st.school_id AND sec.structure_id=st.id AND sec.class_id=$3 WHERE st.school_id=$1 AND st.id=$2',
        [sid, b.structure_id, b.class_id],
      )
    ).rows[0];
  if (!st) throw notFound();
  const items = (
    await tx.query(
      'SELECT *,first_due_on::text AS first_due_on FROM fee_structure_items WHERE school_id=$1 AND structure_id=$2 AND (class_id IS NULL OR class_id=$3)',
      [sid, b.structure_id, b.class_id],
    )
  ).rows;
  const dates = items.flatMap((i) =>
    installmentDates(iso(i.first_due_on), iso(st.ends_on), i.frequency).map((due, index) => ({
      item_id: i.id,
      fee_type: i.label,
      amount: i.amount,
      category: i.category,
      due_on: due,
      installment_label: `${i.label} · ${index + 1} · ${due}`,
      key: hash(JSON.stringify([st.academic_session_id, i.category, i.label.toLowerCase(), due])),
    })),
  );
  const base = `SELECT DISTINCT $1::uuid AS school_id,e.student_id,$3::uuid AS academic_session_id,$2::uuid AS class_id,x.item_id,x.fee_type,x.amount,x.category,x.due_on,x.installment_label,'ACADEMIC:'||e.student_id||':'||x.key AS assessment_key FROM ${roster ? 'jsonb_to_recordset($6::jsonb) AS e(student_id uuid,starts_on date,ends_on date)' : 'enrollments e'} CROSS JOIN jsonb_to_recordset($4::jsonb) AS x(item_id uuid,fee_type text,amount numeric,category text,due_on date,installment_label text,key text) WHERE ${roster ? '$1::uuid IS NOT NULL AND $2::uuid IS NOT NULL AND $3::uuid IS NOT NULL' : "e.school_id=$1 AND e.class_id=$2 AND e.academic_session_id=$3 AND e.status='ACTIVE'"} AND ($5::uuid IS NULL OR e.student_id=$5) AND x.due_on>=e.starts_on AND (e.ends_on IS NULL OR x.due_on<=e.ends_on)`;
  const scopedBase = studentIds ? `${base} AND e.student_id=ANY($${roster ? 7 : 6}::uuid[])` : base;
  const v = [
    sid,
    b.class_id,
    st.academic_session_id,
    JSON.stringify(dates),
    b.student_id || null,
    ...(roster ? [JSON.stringify(roster)] : []),
    ...(studentIds ? [studentIds] : []),
  ];
  if (preview)
    return (
      await tx.query(
        `WITH desired AS(${scopedBase}) SELECT count(*)::int AS installments,coalesce(sum(amount),0)::text AS amount FROM desired d WHERE NOT EXISTS(SELECT FROM fee_records f WHERE f.school_id=d.school_id AND f.assessment_key=d.assessment_key AND f.voided_at IS NULL)`,
        v,
      )
    ).rows[0];
  const result = await tx.query(
    `WITH desired AS(${scopedBase}) INSERT INTO fee_records(school_id,student_id,academic_session_id,class_id,structure_item_id,fee_type,amount_due,category,due_on,installment_label,assessment_key,status) SELECT school_id,student_id,academic_session_id,class_id,item_id,fee_type,amount,category,due_on,installment_label,assessment_key,'UNPAID' FROM desired ORDER BY student_id,due_on,item_id ON CONFLICT(school_id,assessment_key) WHERE voided_at IS NULL DO NOTHING RETURNING id`,
    v,
  );
  return { created: result.rowCount };
}
