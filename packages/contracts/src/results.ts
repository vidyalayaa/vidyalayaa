import { z } from 'zod';

const percentage = z.number().min(0).max(100);
export const resultPolicySchema = z
  .object({
    pass_percentage: percentage.nullable(),
    grades: z
      .array(z.object({ label: z.string().trim().min(1).max(20), minimum: percentage }).strict())
      .max(12),
  })
  .strict()
  .superRefine(({ grades }, ctx) => {
    if (
      new Set(grades.map((grade) => grade.minimum)).size !== grades.length ||
      new Set(grades.map((grade) => grade.label.toLowerCase())).size !== grades.length ||
      (grades.length > 0 && !grades.some((grade) => grade.minimum === 0))
    )
      ctx.addIssue({
        code: 'custom',
        path: ['grades'],
        message: 'Use unique grade labels and thresholds, including a grade that starts at 0%.',
      });
  });

export type ResultPolicy = z.infer<typeof resultPolicySchema>;
export type ResultStatus = 'NO_MARKS' | 'INCOMPLETE' | 'RECORDED' | 'PASSED' | 'FAILED';

export interface ResultExam {
  id: string;
  cohort_id: string;
  class_id: string;
  session_id: string;
  session_name: string;
  grade: string;
  section: string;
  name: string;
  exam_type: string;
  assessment_kind: 'OFFICIAL' | 'SUBJECT_TEST';
  subject_name: string | null;
  max_score: number;
  starts_on: string | null;
  status: 'DRAFT' | 'OPEN' | 'LOCKED' | 'PUBLISHED';
}

export interface ResultPosition {
  rank: number;
  tied: boolean;
}

export interface ResultStanding {
  student_id: string;
  name: string;
  student_code: string;
  exam_id: string;
  class_id: string;
  grade: string;
  section: string;
  obtained: number | null;
  maximum: number | null;
  percentage: number | null;
  class_position: ResultPosition | null;
  school_position: ResultPosition | null;
}

export interface StudentExamResult {
  school_name: string;
  exam: ResultExam;
  student: ResultStanding;
  status: ResultStatus;
  grade: string | null;
  recorded_maximum: number | null;
  subjects: {
    subject_id: string;
    name: string;
    score: number | null;
    maximum: number;
    percentage: number | null;
    grade: string | null;
    remarks: string | null;
  }[];
}

export interface ClassResultStatistics {
  class_id: string;
  exam_id: string;
  grade: string;
  section: string;
  total: number;
  appeared: number;
  passed: number | null;
  failed: number | null;
  incomplete: number;
  average_marks: number | null;
  average_percentage: number | null;
  highest_marks: number | null;
  lowest_marks: number | null;
  toppers: ResultStanding[];
}

export interface PerformancePoint {
  id: string;
  name: string;
  percentage: number;
  count: number;
}

export interface SchoolResultAnalytics {
  classes: ClassResultStatistics[];
  school_toppers: ResultStanding[];
  subjects: PerformancePoint[];
  distribution: { name: string; count: number }[];
  exam_comparison: PerformancePoint[];
  session_trend: PerformancePoint[];
  pass_percentage: number | null;
}
