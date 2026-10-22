export interface DirectoryClass extends Record<string, unknown> {
  id: string;
  grade: string;
  section: string;
  academic_session_id: string;
  session_name: string;
  is_current: boolean;
  student_count: number;
}
export interface DirectoryStudent extends Record<string, unknown> {
  id: string;
  student_code: string;
  first_name: string;
  last_name: string | null;
  email: string | null;
  date_of_birth: string | null;
  sex: 'NOT_SPECIFIED' | 'MALE' | 'FEMALE' | 'OTHER';
  status: string;
  enrollment_id: string | null;
  roll_number: string | null;
}
