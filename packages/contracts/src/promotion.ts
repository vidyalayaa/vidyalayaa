import { z } from 'zod';
const id = z.guid();
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (v) => !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v,
    'Choose a valid date.',
  );
export const prepareYearSchema = z
  .object({
    source_session_id: id,
    new_year: z
      .object({ name: z.string().trim().min(1).max(100), starts_on: day, ends_on: day })
      .strict()
      .optional(),
    target_session_id: id.optional(),
    copy_teaching: z.boolean(),
    copy_timetable: z.boolean(),
    copy_fees: z.boolean(),
  })
  .strict()
  .refine(
    (v) => !!v.new_year !== !!v.target_session_id,
    'Choose an existing target year or enter a new year.',
  )
  .refine(
    (v) => !v.copy_timetable || v.copy_teaching,
    'Copy subject assignments when copying the timetable.',
  );
export const promotionPlanSchema = z
  .object({
    promotion_id: id,
    activation_on: day,
    generate_fees: z.boolean(),
    roll_numbers: z.enum(['KEEP', 'RENUMBER']).default('KEEP'),
    mappings: z
      .array(
        z
          .object({
            source_class_id: id,
            outcome: z
              .enum(['PROMOTE', 'REPEAT', 'GRADUATED', 'TRANSFERRED', 'WITHDRAWN'])
              .default('PROMOTE'),
            target_class_id: id.nullable(),
            fee_structure_id: id.nullable(),
          })
          .strict(),
      )
      .max(2000),
    exceptions: z
      .array(
        z
          .object({
            enrollment_id: id,
            outcome: z.enum(['PROMOTE', 'REPEAT', 'GRADUATED', 'TRANSFERRED', 'WITHDRAWN']),
            target_class_id: id.nullable(),
            roll_number: z.string().trim().max(80).nullable(),
            reason: z.string().trim().min(2).max(500),
          })
          .strict(),
      )
      .max(20000),
  })
  .strict();
export type PrepareYearInput = z.infer<typeof prepareYearSchema>;
export type PromotionPlan = z.infer<typeof promotionPlanSchema>;
export interface PromotionYear {
  id: string;
  name: string;
  starts_on: string;
  ends_on: string;
  is_current: boolean;
  closed_at: string | null;
}
export interface PromotionClass {
  id: string;
  grade: string;
  section: string;
  academic_session_id: string;
  class_teacher_id: string | null;
  class_teacher: string | null;
  teacher_active: boolean;
  subjects: number;
  timetable_periods: number;
}
export interface PromotionStudent {
  id: string;
  student_id: string;
  student_code: string;
  student_name: string;
  class_id: string;
  grade: string;
  section: string;
  roll_number: string | null;
  starts_on: string;
  ends_on: string | null;
  updated_at: string;
}
export interface PromotionRun {
  id: string;
  source_session_id: string;
  target_session_id: string;
  status: 'PREPARED' | 'COMPLETED';
  class_copies: { source_class_id: string; target_class_id: string }[];
  created_at: string;
  completed_at: string | null;
  result: Record<string, unknown> | null;
}
export interface PromotionFeeStructure {
  id: string;
  academic_session_id: string;
  grade: string;
  version: number;
  class_ids: string[];
  items: number;
}
export interface PromotionWorkspace {
  years: PromotionYear[];
  classes: PromotionClass[];
  students: PromotionStudent[];
  runs: PromotionRun[];
  structures: PromotionFeeStructure[];
  today: string;
}
export interface PromotionPreview {
  token: string;
  blockers: string[];
  warnings: string[];
  counts: {
    promoted: number;
    repeating: number;
    graduated: number;
    transferred: number;
    withdrawn: number;
    total: number;
  };
  fees: { installments: number; amount: string; currency: string };
  old_balances: { currency: string; balance: string }[];
  students: {
    enrollment_id: string;
    student_id: string;
    name: string;
    from: string;
    to: string;
    outcome: string;
    roll_number: string | null;
  }[];
  activation_on: string;
}
