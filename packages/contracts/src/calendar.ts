import { z } from 'zod';
// Existing attendance types remain available; all calendar views share these names.
export const calendarKinds = [
  'HOLIDAY',
  'SCHOOL_EVENT',
  'EXAM_DAY',
  'ACTIVITY',
  'ANNOUNCEMENT',
  'OTHER',
  'WEEKEND_OVERRIDE',
  'SHORT_DAY',
] as const;
export type CalendarKind = (typeof calendarKinds)[number];
export const calendarKindLabels: Record<CalendarKind, string> = {
  HOLIDAY: 'Holiday',
  SCHOOL_EVENT: 'School event',
  EXAM_DAY: 'Exam',
  ACTIVITY: 'Activity',
  ANNOUNCEMENT: 'Important announcement',
  OTHER: 'Other',
  WEEKEND_OVERRIDE: 'Weekend opening',
  SHORT_DAY: 'Short day',
};
const calendarDate = z.string().date();
const eventFields = {
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(10000).default(''),
  kind: z.enum(calendarKinds),
  start_date: calendarDate,
  end_date: calendarDate,
  audience: z.enum(['SCHOOL', 'CLASSES']),
  class_ids: z.array(z.guid()).max(1000).default([]),
};
const validate = (
  v: { start_date: string; end_date: string; audience: string; class_ids: string[] },
  ctx: z.RefinementCtx,
) => {
  if (v.end_date < v.start_date)
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['end_date'],
      message: 'End date must be on or after the start date.',
    });
  if (
    (v.audience === 'SCHOOL' && v.class_ids.length) ||
    (v.audience === 'CLASSES' && !v.class_ids.length)
  )
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['class_ids'],
      message:
        'Choose at least one class/section for a targeted event, or no classes for the entire school.',
    });
  if (new Set(v.class_ids).size !== v.class_ids.length)
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['class_ids'],
      message: 'Each section can be selected only once.',
    });
};
export const calendarEventSchema = z.object(eventFields).strict().superRefine(validate);
export const calendarEventUpdateSchema = z
  .object({ ...eventFields, expected_version: z.number().int().positive() })
  .strict()
  .superRefine(validate);
export const calendarDeleteSchema = z
  .object({ expected_version: z.number().int().positive() })
  .strict();
export type CalendarEventInput = z.infer<typeof calendarEventSchema>;
export interface CalendarClass {
  id: string;
  grade: string;
  section: string;
  academic_session_id: string;
  session_name: string;
  is_current: boolean;
  retired_at: string | null;
}
export interface CalendarEvent extends CalendarEventInput {
  id: string;
  version: number;
  targets: CalendarClass[];
}
