import { z } from 'zod';

const id = z.guid();
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (v) => !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v,
    'Enter a valid date.',
  );
export const feeMoney = z
  .number()
  .finite()
  .min(0.01)
  .max(999999999)
  .refine(
    (v) => Math.abs(v * 100 - Math.round(v * 100)) < 0.00001,
    'Use at most two decimal places.',
  );
export const feeFrequencies = [
  'MONTHLY',
  'QUARTERLY',
  'HALF_YEARLY',
  'ANNUAL',
  'ONE_TIME',
] as const;
export const feeCategories = ['TUITION', 'ADMISSION', 'EXAMINATION', 'ANNUAL', 'OTHER'] as const;
export const feeMethods = ['CASH', 'UPI', 'BANK_TRANSFER', 'CARD', 'CHEQUE', 'OTHER'] as const;
export const feeStructureSchema = z
  .object({
    academic_session_id: id,
    grade: z.string().trim().min(1).max(80),
    mode: z.enum(['SAME', 'SECTION']),
    expected_version: z.number().int().min(0),
    items: z
      .array(
        z
          .object({
            class_id: id.nullable(),
            category: z.enum(feeCategories),
            label: z.string().trim().min(1).max(100),
            amount: feeMoney,
            frequency: z.enum(feeFrequencies),
            first_due_on: day,
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict()
  .superRefine((v, c) => {
    const keys = new Set<string>();
    for (const [i, r] of v.items.entries()) {
      if ((v.mode === 'SAME') !== (r.class_id === null))
        c.addIssue({
          code: 'custom',
          path: ['items', i, 'class_id'],
          message: 'Choose a section only for section-specific fees.',
        });
      const key = [r.class_id, r.category, r.label.toLowerCase()].join(':');
      if (keys.has(key))
        c.addIssue({
          code: 'custom',
          path: ['items', i, 'label'],
          message: 'Include each category and label once per section.',
        });
      keys.add(key);
    }
  });
export const feeAssessmentSchema = z
  .object({ structure_id: id, class_id: id, student_id: id.optional() })
  .strict();
export const feeCollectionSchema = z
  .object({
    student_id: id,
    academic_session_id: id,
    payment_date: day,
    payment_method: z.enum(feeMethods),
    receipt_no: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9][A-Za-z0-9/_-]*$/)
      .optional(),
    reference: z.string().trim().max(200).default(''),
    note: z.string().trim().max(1000).default(''),
    allocations: z
      .array(z.object({ fee_id: id, amount: feeMoney }).strict())
      .min(1)
      .max(200),
  })
  .strict()
  .superRefine((v, c) => {
    if (new Set(v.allocations.map((a) => a.fee_id)).size !== v.allocations.length)
      c.addIssue({
        code: 'custom',
        path: ['allocations'],
        message: 'Include each installment once.',
      });
    if (['UPI', 'BANK_TRANSFER', 'CARD', 'CHEQUE'].includes(v.payment_method) && !v.reference)
      c.addIssue({
        code: 'custom',
        path: ['reference'],
        message: 'Enter the transaction or cheque reference.',
      });
    if (v.allocations.reduce((s, a) => s + Math.round(a.amount * 100), 0) > 99999999900)
      c.addIssue({ code: 'custom', path: ['allocations'], message: 'Payment total is too large.' });
  });
export const feeReasonSchema = z.object({ reason: z.string().trim().min(5).max(1000) }).strict();
export const transportRouteSchema = z
  .object({
    name: z.string().trim().min(1).max(150),
    description: z.string().trim().max(500).default(''),
    active: z.boolean().default(true),
  })
  .strict();
export const transportAssignmentSchema = z
  .object({
    student_id: id,
    academic_session_id: id,
    route_id: id,
    amount: feeMoney,
    frequency: z.enum(feeFrequencies),
    starts_on: day,
    ends_on: day,
    first_due_on: day,
  })
  .strict()
  .refine(
    (v) => v.ends_on >= v.starts_on && v.first_due_on >= v.starts_on && v.first_due_on <= v.ends_on,
    'Billing dates must be inside the transport assignment.',
  );
export function feeInstallments(
  first: string,
  last: string,
  frequency: (typeof feeFrequencies)[number],
) {
  const months = { MONTHLY: 1, QUARTERLY: 3, HALF_YEARLY: 6, ANNUAL: 12, ONE_TIME: 0 }[frequency],
    start = new Date(first + 'T00:00:00Z'),
    result: string[] = [];
  for (let n = 0; n <= 120; n++) {
    const target = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + n * months, 1));
    const end = new Date(
      Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
    ).getUTCDate();
    target.setUTCDate(Math.min(start.getUTCDate(), end));
    const value = target.toISOString().slice(0, 10);
    if (value > last) break;
    if (n === 120)
      throw new RangeError(
        'A fee schedule cannot exceed 120 installments. Shorten the academic year or service dates.',
      );
    result.push(value);
    if (!months) break;
  }
  return result;
}
export type FeeStructureInput = z.infer<typeof feeStructureSchema>;
export { day as feeDate };
export type FeeCollectionInput = z.infer<typeof feeCollectionSchema>;
export interface FeeAssessment {
  id: string;
  student_id: string;
  student_label: string;
  academic_session_id: string;
  class_id: string | null;
  class_label: string | null;
  fee_type: string;
  category: string;
  installment_label: string | null;
  amount_due: string;
  amount_paid: string;
  currency: string;
  due_on: string;
  status: string;
  voided_at: string | null;
}
export interface FeePayment {
  id: string;
  receipt_no: string;
  payment_date: string;
  amount: string;
  currency: string;
  payment_method: string;
  reference: string;
  note: string;
  recorded_by: string | null;
  recorded_by_label: string | null;
  reversed_at: string | null;
  reversal_reason: string | null;
  kind: 'PAYMENT' | 'OPENING';
  receipt_snapshot: FeeReceipt;
}
export interface FeeReceipt {
  school_name: string;
  student_name: string;
  student_code: string;
  roll_number: string | null;
  class_label: string | null;
  academic_year: string;
  receipt_no: string;
  payment_date: string | null;
  payment_method: string;
  reference: string;
  note: string;
  recorded_by: string;
  currency: string;
  amount: string;
  balance_after: string;
  lines: { label: string; installment: string; amount: string }[];
  legacy?: boolean;
}
export interface FeeSummary {
  currency: string;
  expected: string;
  collected: string;
  outstanding: string;
  overdue: string;
  transport_expected: string;
  transport_paid: string;
  transport_outstanding: string;
}
export interface FeeStatement {
  student: { id: string; name: string; student_code: string };
  assessments: FeeAssessment[];
  payments: FeePayment[];
  summary: FeeSummary[];
  transport: Record<string, unknown>[];
}
