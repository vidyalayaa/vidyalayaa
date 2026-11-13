import type { ResultExam, ResultStatus, StudentExamResult } from './results.js';

export interface AcademicStudent {
  id: string;
  name: string;
  photo: string | null;
}

export interface AcademicSelection {
  exams: ResultExam[];
  subjects: { id: string; name: string }[];
  students: AcademicStudent[];
}

export interface AcademicSubjectPerformance {
  id: string;
  name: string;
  percentage: number;
  previous: number | null;
  change: number | null;
  class_average: number | null;
  consistency: number | null;
  assessments: number;
}

export interface AcademicTrend {
  exam_id: string;
  name: string;
  date: string;
  percentage: number;
}

export interface AcademicPerformance {
  profile: AcademicStudent;
  report: StudentExamResult;
  subjects: AcademicSubjectPerformance[];
  trend: AcademicTrend[];
}

export interface AcademicReportGroup {
  id: string;
  name: string;
  percentage: number;
  count: number;
}

export interface AcademicCohort {
  average: number | null;
  appeared: number;
  passed: number | null;
  failed: number | null;
  highest: number | null;
  lowest: number | null;
  distribution: { name: string; count: number }[];
  classes: (AcademicReportGroup & {
    average_marks: number;
    average_change: number | null;
    improved: number;
    compared: number;
  })[];
  subjects: AcademicReportGroup[];
  exams: AcademicReportGroup[];
  sessions: AcademicReportGroup[];
  standings: {
    student_id: string;
    name: string;
    exam_id: string;
    class_id: string;
    percentage: number;
    status: ResultStatus;
    class_rank: number | null;
    school_rank: number | null;
    change: number | null;
  }[];
}

export interface AcademicAdvice {
  summary: string;
  strengths: string[];
  priorities: string[];
  goals: { short_term: string; long_term: string };
  tasks: {
    day: number;
    subject: number;
    minutes: number;
    activity: string;
  }[];
}

export interface AcademicGuidance {
  advice: AcademicAdvice;
  plan_id: string;
  completed: number[];
}
