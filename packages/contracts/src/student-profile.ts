export interface StudentProfileEnrollment {
  grade: string;
  section: string;
  roll_number: string | null;
  session_name: string;
  session_starts_on: string;
  session_ends_on: string;
  starts_on: string;
  ends_on: string | null;
  status: 'ACTIVE' | 'ENDED';
  is_current: boolean;
}
export interface StudentProfile {
  student: {
    student_code: string;
    first_name: string;
    last_name: string | null;
    date_of_birth: string | null;
    gender: 'NOT_SPECIFIED' | 'MALE' | 'FEMALE' | 'OTHER';
    email: string | null;
    phone: string | null;
    status: string;
  };
  school: { name: string; school_code: string };
  enrollments: StudentProfileEnrollment[];
  guardians: {
    full_name: string;
    relationship: string;
    email: string | null;
    phone: string | null;
    is_primary_contact: boolean;
  }[];
}
