import { z } from 'zod';

export const attendanceCalendarPeriodSchema = z
  .object({ from: z.iso.date(), to: z.iso.date() })
  .refine(
    ({ from, to }) => to >= from && Date.parse(to) - Date.parse(from) <= 365 * 86400000,
    'Choose a period of up to 366 days.',
  );

export const attendanceCalendarStates = [
  'PRESENT',
  'ABSENT',
  'HALF_DAY',
  'LATE',
  'EXCUSED',
  'PENDING',
  'NOT_RECORDED',
  'HOLIDAY',
  'WEEKLY_OFF',
  'NOT_ENROLLED',
  'FUTURE',
] as const;
export type AttendanceCalendarState = (typeof attendanceCalendarStates)[number];

export interface AttendanceCalendarDay {
  date: string;
  working: number;
  present: number;
  absent: number;
  half_day: number;
  late: number;
  excused: number;
  pending: number;
  unmarked: number;
  holidays: number;
  weekly_off: number;
  holiday_names: string[];
  uses_default_schedule: boolean;
}

export interface AttendanceCalendarResponse {
  today: string;
  days: AttendanceCalendarDay[];
}

export interface AttendanceCalendarOptions {
  sessions: {
    id: string;
    name: string;
    starts_on: string;
    ends_on: string;
    is_current: boolean;
  }[];
  classes: { id: string; academic_session_id: string; grade: string; section: string }[];
}

export interface AttendanceCalendarRecord {
  id: string;
  student_id: string;
  class_id: string;
  first_name: string;
  last_name: string | null;
  student_code: string;
  grade: string | null;
  section: string | null;
  attendance_status: Exclude<
    AttendanceCalendarState,
    'NOT_RECORDED' | 'HOLIDAY' | 'WEEKLY_OFF' | 'NOT_ENROLLED' | 'FUTURE'
  >;
  movement_status: string;
  first_arrival_at: string | null;
  last_departure_at: string | null;
}
