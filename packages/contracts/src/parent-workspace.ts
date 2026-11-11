import { z } from 'zod';
import type { StudentContact } from './person-profiles.js';
export const parentAttendanceStatuses = [
  'PENDING',
  'PRESENT',
  'LATE',
  'HALF_DAY',
  'ABSENT',
  'EXCUSED',
  'NOT_RECORDED',
  'HOLIDAY',
  'WEEKLY_OFF',
  'NOT_ENROLLED',
] as const;
export const parentDateRangeSchema = z
  .object({ from: z.string().date(), to: z.string().date() })
  .refine(
    (v) => v.to >= v.from && (Date.parse(v.to) - Date.parse(v.from)) / 86400000 <= 365,
    'Choose a range of up to 366 days.',
  );
export const parentAttendanceFilterSchema = z.object({
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  status: z.enum(parentAttendanceStatuses).optional(),
});
export const parentResultsFilterSchema = parentAttendanceFilterSchema
  .omit({ status: true })
  .extend({ exam_id: z.guid().optional(), subject_id: z.guid().optional() });
export interface ParentAttendanceDay {
  id: string | null;
  attendance_date: string;
  attendance_status: (typeof parentAttendanceStatuses)[number];
  school_day: boolean;
  day_note: string | null;
  schedule_source: string;
  first_arrival_at: string | null;
  last_departure_at: string | null;
  grade: string | null;
  section: string | null;
}
export interface ParentAttendanceSummary {
  school_days: number;
  present_days: number;
  absent_days: number;
  late_days: number;
  half_days: number;
  excused_days: number;
  pending_days: number;
  unrecorded_days: number;
  finalized_days: number;
  attendance_percentage: number | null;
}
export interface ParentAttendanceResponse extends ParentPage<ParentAttendanceDay> {
  summary: ParentAttendanceSummary;
  range: { from: string; to: string };
  uses_default_schedule: boolean;
}
export interface ParentResultRecord {
  id: string;
  exam_id: string;
  subject_id: string;
  examination: string;
  assessment_kind: string;
  exam_type: string;
  exam_date: string | null;
  result_date: string;
  subject: string;
  score: number;
  max_score: number;
  remarks: string | null;
}
export interface ParentResultChartPoint {
  id: string;
  name: string;
  percentage: number;
  score: number;
  maximum: number;
  count: number;
  date?: string;
}
export interface ParentResultsResponse {
  data: ParentResultRecord[];
  range: { from: string; to: string };
  exams: { id: string; name: string }[];
  subjects: { id: string; name: string }[];
  subject_chart: ParentResultChartPoint[];
  exam_chart: ParentResultChartPoint[];
  summary: { score: number; maximum: number; percentage: number | null; examinations: number };
}
export interface ParentChild {
  id: string;
  student_code: string;
  profile_photo_id?: string | null;
  contact?: StudentContact | null;
  first_name: string;
  last_name: string | null;
  date_of_birth: string | null;
  gender: string;
  email: string | null;
  status: string;
  enrollment: {
    class_id: string;
    grade: string;
    section: string;
    session_name: string;
    academic_session_id: string;
    roll_number: string | null;
    class_teacher: string | null;
    session_starts_on?: string;
  } | null;
}
export interface ParentPage<T> {
  data: T[];
  total: number;
  page: number;
  page_size: number;
}
export const parentSections = [
  'students',
  'attendance',
  'calendar',
  'academics',
  'homework',
  'results',
  'timetable',
  'fees',
  'reports',
  'announcements',
  'notifications',
  'corrections',
] as const;
export type ParentSection = (typeof parentSections)[number];
