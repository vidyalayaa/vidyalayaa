import { z } from 'zod';
export const uuid = z.string().uuid();
export const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const text = z.string().trim().min(1).max(500);
const nullableText = z.string().max(10000).nullable().optional();
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const roles = ['school_admin', 'principal', 'teacher', 'parent', 'student'] as const;
export type Role = (typeof roles)[number];
export const attendanceStatuses = [
  'PENDING',
  'PRESENT',
  'LATE',
  'HALF_DAY',
  'ABSENT',
  'EXCUSED',
] as const;
export type AttendanceStatus = (typeof attendanceStatuses)[number];
export const locationTypes = ['ENTRY', 'EXIT', 'BIDIRECTIONAL', 'CLASSROOM'] as const;
export type LocationType = (typeof locationTypes)[number];
export const ruleSchema = z
  .object({
    arrival: z
      .object({ earliest_accept: time, on_time_start: time, on_time_end: time, late_end: time })
      .strict(),
    departure: z
      .object({
        half_day: z.object({ start: time, end: time }).strict(),
        normal: z.object({ start: time, end: time }).strict(),
      })
      .strict(),
    absent_cutoff: time,
    absent_finalize_grace_minutes: z.number().int().min(0).max(360),
    repeat_tap_debounce_seconds: z.number().int().min(1).max(600),
    allow_reentry: z.boolean(),
    bidirectional_outside_window_action: z.literal('IGNORE_AND_FLAG'),
    classroom_tap_implies_arrival: z.boolean(),
    weekly_off: z.array(z.enum(['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'])),
    notify: z
      .object({
        arrival: z.boolean(),
        late: z.boolean(),
        departure: z.boolean(),
        absent: z.boolean(),
      })
      .strict(),
    late_counts_as: z.enum(['LATE', 'PRESENT']),
    max_clock_skew_seconds: z.number().int().min(1).max(300),
  })
  .strict()
  .superRefine((r, c) => {
    const a = r.arrival,
      d = r.departure;
    if (
      !(
        a.earliest_accept <= a.on_time_start &&
        a.on_time_start < a.on_time_end &&
        a.on_time_end < a.late_end &&
        d.half_day.start < d.half_day.end &&
        d.half_day.end <= d.normal.start &&
        d.normal.start < d.normal.end
      )
    )
      c.addIssue({
        code: 'custom',
        message: 'Windows must be ordered; overnight windows are unsupported',
      });
  });
export type RuleSet = z.infer<typeof ruleSchema>;
export const eventSchema = z
  .object({
    event_id: uuid,
    device_id: z.string().min(1).max(64),
    card_uid: z.string().regex(/^[0-9A-F]{8,32}$/),
    event_timestamp: z.string().datetime(),
    time_source: z.enum(['RTC_SYNCED', 'RTC_UNSYNCED', 'NTP', 'MONOTONIC', 'UNKNOWN']),
    sequence_number: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    boot_id: uuid,
    firmware_version: z.string().min(1).max(40),
    uptime_ms: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict();
export type DeviceEvent = z.infer<typeof eventSchema>;
export const batchSchema = z
  .object({
    batch_id: uuid,
    device_id: text,
    firmware_version: text,
    sent_at: z.string().datetime(),
    events: z.array(eventSchema).min(1).max(100),
  })
  .strict()
  .superRefine((b, c) => {
    if (b.events.some((e, i) => i > 0 && e.sequence_number <= b.events[i - 1].sequence_number))
      c.addIssue({ code: 'custom', message: 'Events must be in ascending sequence order' });
  });
export const heartbeatSchema = z
  .object({
    device_id: text,
    boot_id: uuid,
    device_time: z.string().datetime(),
    uptime_ms: z.number().int().nonnegative(),
    firmware_version: text,
    config_version: z.number().int().positive(),
    pending_events: z.number().int().nonnegative(),
    oldest_pending_sequence: z.number().int().nullable(),
    last_sequence: z.number().int().nonnegative(),
    storage_used_pct: z.number().int().min(0).max(100),
    reader_status: z.enum(['OK', 'DEGRADED', 'FAIL', 'UNKNOWN']),
    rtc_status: z.enum(['OK', 'DRIFT', 'LOST_POWER', 'UNKNOWN']),
    last_ntp_sync: z.string().datetime().nullable(),
    wifi_rssi_dbm: z.number().int().min(-127).max(0).nullable(),
    reset_reason: text,
    logs: z
      .array(
        z
          .object({
            ts: z.string().datetime(),
            level: z.enum(['INFO', 'WARN', 'ERROR']),
            code: text,
            detail: z.record(z.unknown()).optional(),
          })
          .strict(),
      )
      .max(20)
      .default([]),
  })
  .strict();
export const syncAckSchema = z
  .object({
    device_id: text,
    boot_id: uuid,
    purged_through_sequence: z.number().int().nonnegative(),
    pending_events: z.number().int().nonnegative(),
    queue_corruption_count: z.number().int().nonnegative(),
  })
  .strict();
export const otaSchema = z
  .object({
    device_id: text,
    target_version: text,
    state: z.enum(['OFFERED', 'DOWNLOADING', 'VERIFYING', 'INSTALLED', 'FAILED', 'ROLLED_BACK']),
    detail: z.record(z.unknown()),
    reported_at: z.string().datetime(),
  })
  .strict();
export interface EventResult {
  event_id: string;
  status: 'RECORDED' | 'DUPLICATE_EVENT' | 'REJECTED' | 'RETRY_LATER';
  outcome?: string;
  original_status?: string;
  original_outcome?: string;
  attendance_status?: AttendanceStatus;
  movement_status?: string;
  notification_queued: boolean;
  device_action: 'DELETE' | 'RETAIN_AND_RETRY';
  processed_at?: string;
}
export interface Membership {
  school_id: string;
  school_name: string;
  timezone: string;
  role: Role;
  permissions: string[];
}
export interface Me {
  id: string;
  full_name: string;
  email: string;
  memberships: Membership[];
  platform_role: string | null;
  school?: Membership;
  features: Record<string, boolean>;
  limits: Record<string, number>;
  subscription_status: string | null;
}
export interface Page<T = Record<string, unknown>> {
  data: T[];
  page: number;
  page_size: number;
  total: number;
}
export const pageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().max(120).optional(),
  date: date.optional(),
  class_id: uuid.optional(),
});
export const resourceSchemas = {
  students: z
    .object({
      student_code: text,
      first_name: text,
      last_name: nullableText,
      date_of_birth: date.nullable().optional(),
      user_id: uuid.nullable().optional(),
      status: z.enum(['ACTIVE', 'TRANSFERRED', 'GRADUATED', 'WITHDRAWN']).default('ACTIVE'),
    })
    .strict(),
  parents: z
    .object({
      full_name: text,
      email: z.string().email().nullable().optional(),
      phone: z.string().max(30).nullable().optional(),
      user_id: uuid.nullable().optional(),
      status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
    })
    .strict(),
  teachers: z
    .object({
      staff_code: text,
      full_name: text,
      user_id: uuid.nullable().optional(),
      status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
    })
    .strict(),
  academic_sessions: z
    .object({ name: text, starts_on: date, ends_on: date, is_current: z.boolean().default(false) })
    .strict(),
  classes: z
    .object({
      academic_session_id: uuid,
      grade: text,
      section: text,
      class_teacher_id: uuid.nullable().optional(),
    })
    .strict(),
  subjects: z.object({ code: text, name: text }).strict(),
  enrollments: z
    .object({
      student_id: uuid,
      class_id: uuid,
      academic_session_id: uuid,
      roll_number: nullableText,
      starts_on: date,
      ends_on: date.nullable().optional(),
      status: z.enum(['ACTIVE', 'ENDED']).default('ACTIVE'),
    })
    .strict(),
  student_parents: z
    .object({
      student_id: uuid,
      parent_id: uuid,
      relationship: z.enum(['MOTHER', 'FATHER', 'GUARDIAN', 'OTHER']),
      is_primary_contact: z.boolean().default(false),
      can_receive_alerts: z.boolean().default(true),
      status: z.enum(['ACTIVE', 'REVOKED']).default('ACTIVE'),
    })
    .strict(),
  teacher_class_assignments: z
    .object({
      teacher_id: uuid,
      class_id: uuid,
      subject_id: uuid.nullable().optional(),
      starts_on: date,
      ends_on: date.nullable().optional(),
    })
    .strict(),
  exams: z
    .object({
      class_id: uuid,
      name: text,
      exam_type: z.enum(['UNIT', 'MIDTERM', 'FINAL', 'PRACTICAL']),
      starts_on: date.nullable().optional(),
      max_score: z.number().positive().max(9999),
      status: z.enum(['DRAFT', 'OPEN', 'LOCKED', 'PUBLISHED']).default('DRAFT'),
    })
    .strict(),
  marks: z
    .object({
      exam_id: uuid,
      student_id: uuid,
      subject_id: uuid,
      score: z.number().min(0).max(9999),
      remarks: nullableText,
    })
    .strict(),
  assignments: z
    .object({
      class_id: uuid,
      subject_id: uuid.nullable().optional(),
      kind: z.enum(['HOMEWORK', 'MATERIAL']),
      title: text,
      body: nullableText,
      due_at: z.string().datetime().nullable().optional(),
      storage_path: nullableText,
    })
    .strict(),
  timetable_entries: z
    .object({
      class_id: uuid,
      subject_id: uuid,
      teacher_id: uuid,
      weekday: z.number().int().min(1).max(7),
      starts_at: time,
      ends_at: time,
      room: nullableText,
    })
    .strict(),
  school_holidays: z
    .object({
      on_date: date,
      kind: z.enum(['HOLIDAY', 'WEEKEND_OVERRIDE', 'EXAM_DAY', 'SHORT_DAY']),
      class_id: uuid.nullable().optional(),
      label: nullableText,
    })
    .strict(),
  announcements: z
    .object({
      audience: z.enum(['SCHOOL', 'CLASS', 'PARENTS', 'STAFF']),
      class_id: uuid.nullable().optional(),
      title: text,
      body: z.string().min(1).max(10000),
      published_at: z.string().datetime().nullable().optional(),
    })
    .strict(),
  fee_records: z
    .object({
      student_id: uuid,
      academic_session_id: uuid,
      fee_type: text,
      amount_due: z.number().min(0).max(999999999),
      amount_paid: z.number().min(0).max(999999999).default(0),
      currency: z
        .string()
        .regex(/^[A-Z]{3}$/)
        .default('INR'),
      due_on: date,
      status: z.enum(['UNPAID', 'PARTIAL', 'PAID', 'WAIVED']).default('UNPAID'),
    })
    .strict(),
  nfc_cards: z
    .object({
      student_id: uuid,
      card_uid: z.string().regex(/^[0-9A-F]{8,32}$/),
      status: z.enum(['ACTIVE', 'BLOCKED', 'LOST', 'RETIRED']).default('ACTIVE'),
      blocked_reason: nullableText,
    })
    .strict(),
  device_locations: z
    .object({
      name: text,
      location_type: z.enum(locationTypes),
      class_id: uuid.nullable().optional(),
      campus_label: nullableText,
      is_active: z.boolean().default(true),
    })
    .strict(),
  attendance_rule_versions: z
    .object({
      class_id: uuid.nullable().optional(),
      day_type: z.enum(['REGULAR', 'EXAM', 'SHORT_DAY']),
      version_no: z.number().int().positive(),
      effective_from: date,
      effective_to: date.nullable().optional(),
      rules: ruleSchema,
    })
    .strict(),
  notification_preferences: z
    .object({
      parent_id: uuid,
      kind: text,
      channel: z.enum(['PUSH', 'EMAIL', 'SMS']),
      enabled: z.boolean(),
      quiet_start: time.nullable().optional(),
      quiet_end: time.nullable().optional(),
    })
    .strict(),
};
export type Resource = keyof typeof resourceSchemas;
export type ResourceInput<K extends Resource> = z.infer<(typeof resourceSchemas)[K]>;
export const resourceNames = Object.keys(resourceSchemas) as Resource[];
export const correctionSchema = z
  .object({
    daily_attendance_id: uuid,
    requested_status: z.enum(attendanceStatuses),
    reason: z.string().min(5).max(2000),
  })
  .strict();
export const reportSchema = z
  .object({
    kind: z.enum(['ATTENDANCE', 'ACADEMIC', 'FEES']),
    student_id: uuid.optional(),
    class_id: uuid.optional(),
    from: date,
    to: date,
  })
  .strict()
  .refine((x) => x.to >= x.from, 'End date must follow start date');
export const inviteSchema = z
  .object({ email: z.string().email(), full_name: text, role: z.enum(roles) })
  .strict();
export const manualSchema = z
  .object({
    student_id: uuid,
    date: date,
    status: z.enum(attendanceStatuses),
    reason: z.string().min(5).max(2000),
    expected_version: z.number().int().nonnegative().optional(),
  })
  .strict();

export { bulkMarksSchema } from './bulk.js';
