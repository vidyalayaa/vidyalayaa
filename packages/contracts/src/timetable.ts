import { z } from 'zod';

export const schoolClock = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a valid 24-hour time.');
const slot = z
  .object({
    label: z.string().trim().min(1).max(80),
    start_time: schoolClock,
    end_time: schoolClock,
  })
  .strict();
export const schoolTimingsSchema = z
  .object({
    days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    start_time: schoolClock,
    lecture_duration: z.number().int().min(5).max(180),
    lecture_count: z.number().int().min(1).max(16),
    periods: z
      .array(slot.extend({ number: z.number().int().min(1).max(16) }))
      .min(1)
      .max(16),
    breaks: z.array(slot).max(10),
  })
  .strict()
  .superRefine((v, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    if (new Set(v.days).size !== v.days.length) issue(['days'], 'Choose each school day once.');
    if (v.periods.length !== v.lecture_count)
      issue(['periods'], 'Generate timings matching the number of lectures.');
    v.periods.forEach((p, i) => {
      if (p.number !== i + 1) issue(['periods', i, 'number'], 'Keep lectures in numbered order.');
      if (i && p.start_time < v.periods[i - 1].end_time)
        issue(['periods', i, 'start_time'], 'Lectures must be in time order without overlapping.');
    });
    const slots = [
      ...v.periods.map((p, i) => ({ ...p, path: ['periods', i] })),
      ...v.breaks.map((p, i) => ({ ...p, path: ['breaks', i] })),
    ];
    slots.forEach((p, i) => {
      if (p.start_time < v.start_time)
        issue([...p.path, 'start_time'], 'This time is before the school start time.');
      if (p.end_time <= p.start_time)
        issue([...p.path, 'end_time'], 'End time must be after start time.');
      slots.slice(0, i).forEach((other) => {
        if (p.start_time < other.end_time && p.end_time > other.start_time)
          issue([...p.path, 'start_time'], 'Lectures and breaks cannot overlap.');
      });
    });
  });
export const schoolTimingsUpdateSchema = z
  .object({
    expected_version: z.number().int().min(0).max(2147483646),
    settings: schoolTimingsSchema,
  })
  .strict();
export type SchoolTimings = z.infer<typeof schoolTimingsSchema>;
export interface TimetableSettings {
  configured: boolean;
  version: number;
  settings: SchoolTimings;
}
export interface TimetableClass {
  id: string;
  grade: string;
  section: string;
  session_name: string;
}
export interface TimetableAssignment {
  id: string;
  subject_id: string;
  subject_label: string;
  teacher_id: string;
  teacher_label: string;
}
export interface TimetableEntry {
  id: string;
  class_id: string;
  subject_id: string;
  teacher_id: string;
  weekday: number;
  starts_at: string;
  ends_at: string;
  room: string | null;
  subject_label: string;
  teacher_label: string;
  class_label: string;
  assignment_valid: boolean;
}
export const defaultSchoolTimings: SchoolTimings = {
  days: [1, 2, 3, 4, 5, 6],
  start_time: '08:00',
  lecture_duration: 40,
  lecture_count: 8,
  breaks: [],
  periods: Array.from({ length: 8 }, (_, i) => ({
    number: i + 1,
    label: `Lecture ${i + 1}`,
    start_time: `${String(8 + Math.floor((i * 40) / 60)).padStart(2, '0')}:${String((i * 40) % 60).padStart(2, '0')}`,
    end_time: `${String(8 + Math.floor(((i + 1) * 40) / 60)).padStart(2, '0')}:${String(((i + 1) * 40) % 60).padStart(2, '0')}`,
  })),
};
