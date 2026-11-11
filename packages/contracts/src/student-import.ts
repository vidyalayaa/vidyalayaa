import { z } from 'zod';
import { MAX_STUDENT_PARENTS } from './student-directory.js';
import { studentContactSchema } from './person-profiles.js';

export const studentImportFields = [
  'student_code',
  'first_name',
  'last_name',
  'email',
  'contact_phone',
  'address',
  'date_of_birth',
  'gender',
  'status',
  'academic_session',
  'class_grade',
  'class_section',
  'roll_number',
  'starts_on',
  'ends_on',
] as const;
export const guardianImportFields = [
  'mode',
  'full_name',
  'email',
  'phone',
  'relationship',
  'is_primary_contact',
  'can_receive_alerts',
] as const;
export const studentImportColumns = [
  ...studentImportFields,
  ...Array.from({ length: MAX_STUDENT_PARENTS }, (_, i) =>
    guardianImportFields.map((field) => `parent_${i + 1}_${field}`),
  ).flat(),
];
const text = z.string().trim().min(1).max(200);
const email = z.string().trim().email().max(254);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.')
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Enter a valid calendar date.');
const upper = (v: unknown) => (typeof v === 'string' ? v.trim().toUpperCase() : v);
const boolean = z.preprocess((v) => {
  if (typeof v === 'string' && ['true', 'false'].includes(v.toLowerCase()))
    return v.toLowerCase() === 'true';
  return v;
}, z.boolean());

const parents: Record<string, z.ZodTypeAny> = {};
for (let i = 1; i <= MAX_STUDENT_PARENTS; i++) {
  parents[`parent_${i}_mode`] = z.preprocess(upper, z.enum(['NEW', 'EXISTING'])).optional();
  parents[`parent_${i}_full_name`] = text.optional();
  parents[`parent_${i}_email`] = email.optional();
  parents[`parent_${i}_phone`] = z.string().trim().max(30).optional();
  parents[`parent_${i}_relationship`] = z
    .preprocess(upper, z.enum(['MOTHER', 'FATHER', 'GUARDIAN', 'OTHER']))
    .optional();
  parents[`parent_${i}_is_primary_contact`] = boolean.optional();
  parents[`parent_${i}_can_receive_alerts`] = boolean.optional();
}
export const studentImportRowSchema = z
  .object({
    student_code: text,
    first_name: text,
    last_name: text.optional(),
    email: email.optional(),
    ...studentContactSchema.shape,
    date_of_birth: date.optional(),
    gender: z.preprocess(
      upper,
      z.enum(['NOT_SPECIFIED', 'MALE', 'FEMALE', 'OTHER']).default('NOT_SPECIFIED'),
    ),
    status: z.preprocess(
      upper,
      z.enum(['ACTIVE', 'TRANSFERRED', 'GRADUATED', 'WITHDRAWN']).default('ACTIVE'),
    ),
    academic_session: text.optional(),
    class_grade: text,
    class_section: text,
    roll_number: text.optional(),
    starts_on: date,
    ends_on: date.optional(),
    ...parents,
  })
  .strict();

export const studentImportRequestSchema = z
  .object({
    rows: z.array(z.record(z.string(), z.unknown())).min(1).max(500),
    validate_only: z.boolean().default(true),
  })
  .strict();
