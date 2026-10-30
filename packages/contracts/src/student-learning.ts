import type { ParentResultRecord, ParentResultsResponse } from './parent-workspace.js';

export interface StudentAcademicClass {
  class_id: string;
  grade: string;
  section: string;
  roll_number: string | null;
  session_name: string;
  session_starts_on: string;
  session_ends_on: string;
  class_teacher: string | null;
  subjects: {
    id: string;
    name: string;
    code: string;
    teachers: string[];
  }[];
}
export interface StudentAcademics {
  classes: StudentAcademicClass[];
}
export interface StudentResultRecord extends ParentResultRecord {
  grade: string;
  section: string;
  session_name: string;
}
export interface StudentResults
  extends Pick<
    ParentResultsResponse,
    'summary' | 'subject_chart' | 'exam_chart' | 'exams' | 'subjects'
  > {
  data: StudentResultRecord[];
  total: number;
  page: number;
  page_size: number;
}
