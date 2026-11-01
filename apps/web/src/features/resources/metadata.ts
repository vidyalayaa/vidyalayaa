import type { Resource, Role } from '@vidyalayaa/contracts';
export interface Field {
  key: string;
  type?:
    | 'text'
    | 'email'
    | 'date'
    | 'datetime-local'
    | 'number'
    | 'checkbox'
    | 'textarea'
    | 'select';
  options?: string[];
  ref?: Resource;
  optional?: boolean;
  accountRole?: Role;
}
const ref = (key: string, resource: Resource, optional = false): Field => ({
  key,
  ref: resource,
  optional,
});
const select = (key: string, options: string[]): Field => ({ key, type: 'select', options });
export const fields: Record<Resource, Field[]> = {
  students: [
    { key: 'student_code' },
    { key: 'email', type: 'email', optional: true },
    { key: 'first_name' },
    { key: 'last_name', optional: true },
    { key: 'date_of_birth', type: 'date', optional: true },
    select('gender', ['NOT_SPECIFIED', 'MALE', 'FEMALE', 'OTHER']),
    select('status', ['ACTIVE', 'TRANSFERRED', 'GRADUATED', 'WITHDRAWN']),
  ],
  parents: [
    { key: 'full_name' },
    { key: 'email', type: 'email', optional: true },
    { key: 'phone', optional: true },
    select('status', ['ACTIVE', 'INACTIVE']),
  ],
  teachers: [
    { key: 'staff_code' },
    { key: 'email', type: 'email', optional: true },
    select('staff_role', ['teacher', 'principal', 'school_admin', 'finance_staff']),
    { key: 'full_name' },
    select('status', ['ACTIVE', 'INACTIVE']),
  ],
  academic_sessions: [
    { key: 'name' },
    { key: 'starts_on', type: 'date' },
    { key: 'ends_on', type: 'date' },
    { key: 'is_current', type: 'checkbox' },
  ],
  classes: [
    ref('academic_session_id', 'academic_sessions'),
    { key: 'grade' },
    { key: 'section' },
    ref('class_teacher_id', 'teachers'),
  ],
  subjects: [{ key: 'code' }, { key: 'name' }],
  enrollments: [
    ref('student_id', 'students'),
    ref('class_id', 'classes'),
    ref('academic_session_id', 'academic_sessions'),
    { key: 'roll_number', optional: true },
    { key: 'starts_on', type: 'date' },
    { key: 'ends_on', type: 'date', optional: true },
    select('status', ['ACTIVE', 'ENDED']),
  ],
  student_parents: [
    ref('student_id', 'students'),
    ref('parent_id', 'parents'),
    select('relationship', ['MOTHER', 'FATHER', 'GUARDIAN', 'OTHER']),
    { key: 'is_primary_contact', type: 'checkbox' },
    { key: 'can_receive_alerts', type: 'checkbox' },
    select('status', ['ACTIVE', 'REVOKED']),
  ],
  teacher_class_assignments: [
    ref('teacher_id', 'teachers'),
    ref('class_id', 'classes'),
    ref('subject_id', 'subjects'),
    { key: 'starts_on', type: 'date' },
    { key: 'ends_on', type: 'date', optional: true },
  ],
  exams: [
    ref('class_id', 'classes'),
    select('assessment_kind', ['OFFICIAL', 'SUBJECT_TEST']),
    ref('subject_id', 'subjects', true),
    { key: 'name' },
    select('exam_type', ['UNIT', 'MIDTERM', 'FINAL', 'PRACTICAL']),
    { key: 'starts_on', type: 'date', optional: true },
    { key: 'max_score', type: 'number' },
    select('status', ['DRAFT', 'OPEN', 'LOCKED', 'PUBLISHED']),
  ],
  marks: [
    ref('exam_id', 'exams'),
    ref('student_id', 'students'),
    ref('subject_id', 'subjects'),
    { key: 'score', type: 'number' },
    { key: 'remarks', type: 'textarea', optional: true },
  ],
  assignments: [
    ref('class_id', 'classes'),
    ref('subject_id', 'subjects', true),
    select('kind', ['HOMEWORK', 'MATERIAL']),
    { key: 'title' },
    { key: 'body', type: 'textarea', optional: true },
    { key: 'assigned_on', type: 'date', optional: true },
    { key: 'instructions', type: 'textarea', optional: true },
    { key: 'reference_url', optional: true },
    { key: 'due_at', type: 'datetime-local', optional: true },
    { key: 'storage_path', optional: true },
  ],
  timetable_entries: [
    ref('class_id', 'classes'),
    ref('subject_id', 'subjects'),
    ref('teacher_id', 'teachers'),
    { key: 'weekday', type: 'number' },
    { key: 'starts_at' },
    { key: 'ends_at' },
    { key: 'room', optional: true },
  ],
  school_holidays: [
    { key: 'on_date', type: 'date' },
    select('kind', ['HOLIDAY', 'WEEKEND_OVERRIDE', 'EXAM_DAY', 'SHORT_DAY']),
    ref('class_id', 'classes', true),
    { key: 'label', optional: true },
  ],
  announcements: [
    select('audience', ['SCHOOL', 'CLASS', 'PARENTS', 'STAFF']),
    ref('class_id', 'classes', true),
    { key: 'title' },
    { key: 'body', type: 'textarea' },
    { key: 'published_at', type: 'datetime-local', optional: true },
  ],
  fee_records: [
    ref('student_id', 'students'),
    ref('academic_session_id', 'academic_sessions'),
    { key: 'fee_type' },
    { key: 'amount_due', type: 'number' },
    { key: 'amount_paid', type: 'number' },
    { key: 'currency' },
    { key: 'due_on', type: 'date' },
    select('status', ['UNPAID', 'PARTIAL', 'PAID', 'WAIVED']),
  ],
  nfc_cards: [
    ref('student_id', 'students'),
    { key: 'card_uid' },
    select('status', ['ACTIVE', 'BLOCKED', 'LOST', 'RETIRED']),
    { key: 'blocked_reason', type: 'textarea', optional: true },
  ],
  device_locations: [
    { key: 'name' },
    select('location_type', ['ENTRY', 'EXIT', 'BIDIRECTIONAL', 'CLASSROOM']),
    ref('class_id', 'classes', true),
    { key: 'campus_label', optional: true },
    { key: 'is_active', type: 'checkbox' },
  ],
  attendance_rule_versions: [
    ref('class_id', 'classes', true),
    select('day_type', ['REGULAR', 'EXAM', 'SHORT_DAY']),
    { key: 'version_no', type: 'number' },
    { key: 'effective_from', type: 'date' },
    { key: 'effective_to', type: 'date', optional: true },
    { key: 'rules', type: 'textarea' },
  ],
  notification_preferences: [
    ref('parent_id', 'parents'),
    { key: 'kind' },
    select('channel', ['PUSH', 'EMAIL', 'SMS']),
    { key: 'enabled', type: 'checkbox' },
    { key: 'quiet_start', optional: true },
    { key: 'quiet_end', optional: true },
  ],
};
export const resourceInfo: Record<
  Resource,
  {
    title: string;
    description: string;
    permission: string;
    write?: string;
    feature?: string;
    columns: string[];
  }
> = {
  students: {
    title: 'Students',
    description: 'Every learner. One connected school.',
    permission: 'students.read',
    write: 'students.write',
    columns: ['student_code', 'first_name', 'last_name', 'status'],
  },
  parents: {
    title: 'Parents & guardians',
    description: 'The people behind every student.',
    permission: 'parents.read',
    write: 'parents.write',
    columns: ['full_name', 'email', 'phone', 'status'],
  },
  teachers: {
    title: 'School staff',
    description:
      'Add teachers, principals and school administrators before inviting their accounts.',
    permission: 'teachers.read',
    write: 'teachers.write',
    columns: ['staff_code', 'full_name', 'email', 'staff_role', 'status'],
  },
  academic_sessions: {
    title: 'Academic sessions',
    description: 'Build the foundation for your school year.',
    permission: 'academics.read',
    write: 'academics.write',
    columns: ['name', 'starts_on', 'ends_on', 'is_current'],
  },
  classes: {
    title: 'Classes & sections',
    description: 'A little structure. A lot of possibility.',
    permission: 'academics.read',
    write: 'academics.write',
    columns: ['grade', 'section', 'academic_session_id', 'class_teacher_id'],
  },
  subjects: {
    title: 'Subjects',
    description: 'Your curriculum, clearly organized.',
    permission: 'academics.read',
    write: 'academics.write',
    columns: ['code', 'name'],
  },
  enrollments: {
    title: 'Enrollments',
    description: 'Keep class membership and its history together.',
    permission: 'academics.read',
    write: 'students.write',
    columns: ['student_id', 'class_id', 'roll_number', 'status'],
  },
  student_parents: {
    title: 'Family connections',
    description: 'Control which guardians can access each student.',
    permission: 'parents.read',
    write: 'parents.write',
    columns: ['student_id', 'parent_id', 'relationship', 'status'],
  },
  teacher_class_assignments: {
    title: 'Teaching assignments',
    description: 'The right teachers, classes, and subjects.',
    permission: 'teachers.read',
    write: 'teachers.write',
    columns: ['teacher_id', 'class_id', 'subject_id', 'starts_on'],
  },
  exams: {
    title: 'Exams & results',
    description: 'Make room for every achievement.',
    permission: 'marks.read',
    write: 'assessments.write',
    columns: ['name', 'assessment_kind', 'subject_id', 'exam_type', 'max_score', 'status'],
  },
  marks: {
    title: 'Marks',
    description: 'Thoughtful assessment. Clear progress.',
    permission: 'marks.read',
    write: 'marks.write',
    columns: ['student_id', 'exam_id', 'subject_id', 'score'],
  },
  assignments: {
    title: 'Homework & materials',
    description: 'Keep learning moving beyond the classroom.',
    permission: 'assignments.read',
    write: 'assignments.write',
    feature: 'assignments',
    columns: ['title', 'kind', 'class_id', 'due_at'],
  },
  timetable_entries: {
    title: 'Timetable',
    description: 'A rhythm that works for your school.',
    permission: 'timetable.read',
    write: 'timetable.write',
    feature: 'timetable',
    columns: ['weekday', 'starts_at', 'ends_at', 'class_id', 'subject_id', 'room'],
  },
  school_holidays: {
    title: 'School calendar',
    description: 'Plan for the days that matter.',
    permission: 'academics.read',
    write: 'academics.write',
    columns: ['on_date', 'kind', 'label'],
  },
  announcements: {
    title: 'Announcements',
    description: 'Bring your school community up to date.',
    permission: 'announcements.read',
    write: 'announcements.write',
    columns: ['title', 'audience', 'published_at'],
  },
  fee_records: {
    title: 'Fees',
    description: 'Clear records. Fewer follow-ups.',
    permission: 'fees.read',
    write: 'fees.write',
    columns: ['student_id', 'fee_type', 'amount_due', 'amount_paid', 'due_on', 'status'],
  },
  nfc_cards: {
    title: 'NFC cards',
    description: 'A secure connection from card to classroom.',
    permission: 'cards.read',
    write: 'cards.manage',
    feature: 'nfc_attendance',
    columns: ['student_id', 'card_uid', 'status', 'issued_at'],
  },
  device_locations: {
    title: 'Device locations',
    description: 'Map every entrance, exit, and classroom.',
    permission: 'devices.read',
    write: 'devices.manage',
    feature: 'nfc_attendance',
    columns: ['name', 'location_type', 'is_active'],
  },
  attendance_rule_versions: {
    title: 'Attendance rules',
    description: 'Your school’s schedule, precisely defined.',
    permission: 'rules.read',
    write: 'rules.manage',
    feature: 'nfc_attendance',
    columns: ['version_no', 'day_type', 'effective_from', 'effective_to'],
  },
  notification_preferences: {
    title: 'Notification preferences',
    description: 'Choose how your school reaches you.',
    permission: 'notifications.preferences',
    write: 'notifications.preferences',
    columns: ['kind', 'channel', 'enabled', 'quiet_start', 'quiet_end'],
  },
};
export const sampleRule = {
  arrival: {
    earliest_accept: '06:30',
    on_time_start: '08:00',
    on_time_end: '08:30',
    late_end: '12:00',
  },
  departure: {
    half_day: { start: '12:00', end: '13:00' },
    normal: { start: '14:00', end: '15:00' },
  },
  absent_cutoff: '12:00',
  absent_finalize_grace_minutes: 30,
  repeat_tap_debounce_seconds: 60,
  allow_reentry: true,
  bidirectional_outside_window_action: 'IGNORE_AND_FLAG',
  classroom_tap_implies_arrival: false,
  weekly_off: ['SUN'],
  notify: { arrival: true, late: true, departure: true, absent: true },
  late_counts_as: 'LATE',
  max_clock_skew_seconds: 120,
};
