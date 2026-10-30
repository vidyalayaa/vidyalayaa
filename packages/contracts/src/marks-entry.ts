export interface MarksEntrySheet {
  exam: {
    id: string;
    name: string;
    class_id: string;
    assessment_kind: 'OFFICIAL' | 'SUBJECT_TEST';
    subject_id: string | null;
    max_score: number;
  };
  classroom: { grade: string; section: string; academic_session: string };
  subjects: { id: string; code: string; name: string }[];
  students: {
    id: string;
    student_code: string;
    first_name: string;
    last_name: string | null;
    roll_number: string | null;
  }[];
  marks: { student_id: string; subject_id: string; score: number; remarks: string | null }[];
}
