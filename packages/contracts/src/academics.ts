export interface AcademicSession extends Record<string, unknown> {
  id: string;
  name: string;
  is_current: boolean;
  starts_on: string;
  ends_on: string;
  closed_at?: string | null;
}
export interface AcademicClass extends Record<string, unknown> {
  id: string;
  grade: string;
  section: string;
  academic_session_id: string;
  academic_session_label: string;
  class_teacher_id: string | null;
  class_teacher_label: string | null;
  class_teacher_status: string | null;
  student_count: number;
  male_count: number;
  female_count: number;
  other_count: number;
  unspecified_count: number;
  subject_count: number;
  assignment_count: number;
  legacy_assignment_count: number;
}
export interface AcademicTeacherAssignment extends Record<string, unknown> {
  id: string;
  teacher_id: string;
  class_id: string;
  subject_id: string;
  teacher_label: string;
  staff_code: string;
  teacher_status: string;
  starts_on: string;
  ends_on: string | null;
  is_current: boolean;
}
export interface AcademicSubject extends Record<string, unknown> {
  id: string;
  code: string;
  name: string;
  teachers: AcademicTeacherAssignment[];
}
export interface AcademicEnrollment extends Record<string, unknown> {
  id: string;
  student_id: string;
  student_code: string;
  student_label: string;
  student_status: string;
  class_id: string;
  academic_session_id: string;
  status: 'ACTIVE' | 'ENDED';
  starts_on: string;
  ends_on: string | null;
}
