import {
  resultPolicySchema,
  type ClassResultStatistics,
  type PerformancePoint,
  type ResultExam,
  type ResultPolicy,
  type ResultPosition,
  type ResultStanding,
  type ResultStatus,
} from '@vidyalayaa/contracts';
import type { Tx } from '../../lib/db.js';

const examCatalogue = `
WITH named_exams AS (
  SELECT ex.id,ex.school_id,ex.class_id,c.academic_session_id AS session_id,ac.name AS session_name,
    c.grade,c.section,ex.name,ex.exam_type,ex.assessment_kind,ex.subject_id,sub.name AS subject_name,
    ex.max_score,ex.starts_on::text,ex.status,
    coalesce(ex.starts_on,(ex.created_at AT TIME ZONE sc.timezone)::date) AS roster_date,
    jsonb_build_array(c.academic_session_id,lower(regexp_replace(trim(ex.name),'[[:space:]]+',' ','g')),
      ex.exam_type,ex.assessment_kind,
      CASE WHEN ex.assessment_kind='SUBJECT_TEST' THEN lower(trim(sub.name)) END) AS signature
  FROM exams ex JOIN classes c ON (c.school_id,c.id)=(ex.school_id,ex.class_id)
  JOIN academic_sessions ac ON (ac.school_id,ac.id)=(c.school_id,c.academic_session_id)
  JOIN schools sc ON sc.id=ex.school_id
  LEFT JOIN subjects sub ON (sub.school_id,sub.id)=(ex.school_id,ex.subject_id)
  WHERE ex.school_id=$1 AND ex.retired_at IS NULL AND ($2::uuid IS NULL OR ac.id=$2)
), distinct_exams AS (
  SELECT *,count(*) OVER(PARTITION BY class_id,signature)>1 AS ambiguous FROM named_exams
), exam_catalogue AS (
  SELECT *,first_value(id) OVER(PARTITION BY signature,CASE WHEN ambiguous THEN id END
    ORDER BY id) AS cohort_id FROM distinct_exams
)`;

export async function resultExams(tx: Tx, school: string, session?: string) {
  return (
    await tx.query<ResultExam>(
      `${examCatalogue}
       SELECT id,cohort_id,class_id,session_id,session_name,grade,section,name,exam_type,
         assessment_kind,subject_name,max_score::float8,starts_on,status
       FROM exam_catalogue ORDER BY starts_on DESC NULLS LAST,name,id`,
      [school, session || null],
    )
  ).rows;
}

export async function resultSchool(tx: Tx, school: string) {
  const row = (
    await tx.query<{ name: string; policy: unknown }>(
      "SELECT name,settings->'result_policy' AS policy FROM schools WHERE id=$1",
      [school],
    )
  ).rows[0];
  const parsed = resultPolicySchema.safeParse(row.policy);
  return {
    name: row.name,
    policy: parsed.success ? parsed.data : { pass_percentage: null, grades: [] },
  };
}

// For dated exams, use the enrollment at the exam date. Marks also preserve historical
// participants, including those recorded after the original roster date.
const cohortRoster = `
WITH selected_exams AS (
  SELECT ex.*,coalesce(ex.starts_on,(ex.created_at AT TIME ZONE sc.timezone)::date) AS roster_date
  FROM exams ex JOIN schools sc ON sc.id=ex.school_id
  WHERE ex.school_id=$1 AND ex.id=ANY($2::uuid[]) AND ex.retired_at IS NULL
), recorded AS (
  SELECT m.exam_id,m.student_id,m.subject_id,m.score,m.remarks
  FROM selected_exams ex JOIN marks m ON (m.school_id,m.exam_id)=(ex.school_id,ex.id)
  WHERE ex.assessment_kind='OFFICIAL' OR m.subject_id=ex.subject_id
), participants AS (
  SELECT ex.id AS exam_id,e.student_id
  FROM selected_exams ex JOIN enrollments e ON (e.school_id,e.class_id)=(ex.school_id,ex.class_id)
  WHERE (ex.starts_on IS NULL AND e.status='ACTIVE')
    OR ((e.status='ACTIVE' OR e.ends_on IS NOT NULL) AND e.starts_on<=ex.roster_date
      AND (e.ends_on IS NULL OR e.ends_on>=ex.roster_date))
  UNION SELECT exam_id,student_id FROM recorded
)`;

const examSubjects = `
, exam_subjects AS (
  SELECT r.exam_id,r.subject_id FROM recorded r GROUP BY r.exam_id,r.subject_id
  UNION SELECT id,subject_id FROM selected_exams WHERE assessment_kind='SUBJECT_TEST'
), expected AS (
  SELECT exam_id,count(*)::int AS subject_count FROM exam_subjects GROUP BY exam_id
)`;

export function resultRosterQuery() {
  return `${cohortRoster}
    SELECT s.id,concat_ws(' ',s.first_name,s.last_name) AS full_name,s.student_code
    FROM participants p JOIN students s ON s.school_id=$1 AND s.id=p.student_id
    WHERE concat_ws(' ',s.first_name,s.last_name,s.student_code) ILIKE $3
    ORDER BY s.first_name,s.last_name,s.student_code,s.id`;
}

interface ScoreRow {
  exam_id: string;
  student_id: string;
  name: string;
  student_code: string;
  count: number;
  expected: number;
  obtained: number | null;
  maximum: number | null;
  recorded_maximum: number | null;
  percentage: number | null;
}

export async function resultScores(tx: Tx, school: string, ids: string[]) {
  return (
    await tx.query<ScoreRow>(
      `${cohortRoster}${examSubjects}
       SELECT p.exam_id,p.student_id,concat_ws(' ',s.first_name,s.last_name) AS name,s.student_code,
         count(r.score)::int AS count,coalesce(x.subject_count,0) AS expected,
         sum(r.score)::float8 AS obtained,(ex.max_score*x.subject_count)::float8 AS maximum,
         (ex.max_score*nullif(count(r.score),0))::float8 AS recorded_maximum,
         round(100*sum(r.score)/nullif(ex.max_score*count(r.score),0),2)::float8 AS percentage
       FROM participants p JOIN selected_exams ex ON ex.id=p.exam_id
       JOIN students s ON s.school_id=ex.school_id AND s.id=p.student_id
       LEFT JOIN recorded r ON (r.exam_id,r.student_id)=(p.exam_id,p.student_id)
       LEFT JOIN expected x ON x.exam_id=p.exam_id
       GROUP BY p.exam_id,p.student_id,s.id,ex.max_score,x.subject_count`,
      [school, ids],
    )
  ).rows;
}

export async function resultSubjects(tx: Tx, school: string, exam: string, student: string) {
  return (
    await tx.query<{
      subject_id: string;
      name: string;
      score: number | null;
      maximum: number;
      percentage: number | null;
      remarks: string | null;
    }>(
      `${cohortRoster}${examSubjects}
       SELECT sub.id AS subject_id,sub.name,r.score::float8,ex.max_score::float8 AS maximum,
         round(100*r.score/ex.max_score,2)::float8 AS percentage,r.remarks
       FROM exam_subjects x JOIN selected_exams ex ON ex.id=x.exam_id
       JOIN subjects sub ON (sub.school_id,sub.id)=(ex.school_id,x.subject_id)
       LEFT JOIN recorded r ON r.exam_id=x.exam_id AND r.subject_id=x.subject_id AND r.student_id=$3
       ORDER BY sub.name,sub.id`,
      [school, [exam], student],
    )
  ).rows;
}

export async function subjectPerformance(tx: Tx, school: string, ids: string[]) {
  return (
    await tx.query<PerformancePoint>(
      `${cohortRoster}
       SELECT lower(trim(s.name)) AS id,min(s.name) AS name,count(*)::int AS count,
         round(avg(100*r.score/ex.max_score),2)::float8 AS percentage
       FROM recorded r JOIN selected_exams ex ON ex.id=r.exam_id
       JOIN subjects s ON (s.school_id,s.id)=(ex.school_id,r.subject_id)
       GROUP BY lower(trim(s.name)) ORDER BY percentage DESC,id`,
      [school, ids],
    )
  ).rows;
}

export async function performanceHistory(
  tx: Tx,
  school: string,
  session: string,
  kind: ResultExam['assessment_kind'],
  subject: string | null,
  grade?: string,
  section?: string,
) {
  // Compare the same assessment kind. Average the per-student exam percentages used by the
  // dashboard, while pushing historical aggregation into PostgreSQL.
  const rows = (
    await tx.query<PerformancePoint & { period: 'exam' | 'session' }>(
      `${examCatalogue}, per_student AS (
         SELECT ex.cohort_id,ex.session_id,ex.session_name,ex.name,ex.roster_date::text AS exam_date,
           round(100*sum(m.score)/(ex.max_score*count(*)),2) AS percentage
         FROM exam_catalogue ex JOIN marks m ON (m.school_id,m.exam_id)=(ex.school_id,ex.id)
         WHERE ex.status='PUBLISHED' AND ex.assessment_kind=$6
           AND ($4::text IS NULL OR ex.grade=$4) AND ($5::text IS NULL OR ex.section=$5)
           AND ($7::text IS NULL OR lower(trim(ex.subject_name))=lower(trim($7)))
           AND (ex.assessment_kind='OFFICIAL' OR m.subject_id=ex.subject_id)
         GROUP BY ex.id,ex.cohort_id,ex.session_id,ex.session_name,ex.name,ex.roster_date,ex.max_score,m.student_id
       ), series AS (
         SELECT 'exam' AS period,p.cohort_id AS id,min(p.name) AS name,
           round(avg(p.percentage),2)::float8 AS percentage,count(*)::int AS count,min(p.exam_date) AS ordering
         FROM per_student p WHERE p.session_id=$3 GROUP BY p.cohort_id
         UNION ALL
         SELECT 'session',p.session_id,min(p.session_name),
           round(avg(p.percentage),2)::float8,count(*)::int,min(ac.starts_on::text)
         FROM per_student p JOIN academic_sessions ac ON ac.school_id=$1 AND ac.id=p.session_id
         GROUP BY p.session_id
       ) SELECT period,id,name,percentage,count FROM series ORDER BY ordering NULLS LAST,name,id`,
      [school, null, session, grade || null, section || null, kind, subject],
    )
  ).rows;
  return {
    exam_comparison: rows.filter((row) => row.period === 'exam'),
    session_trend: rows.filter((row) => row.period === 'session'),
  };
}

export function gradeFor(policy: ResultPolicy, percentage: number | null) {
  return percentage === null
    ? null
    : ([...policy.grades]
        .sort((a, b) => b.minimum - a.minimum)
        .find((band) => percentage >= band.minimum)?.label ?? null);
}

export function resultStatus(row: ScoreRow, policy: ResultPolicy): ResultStatus {
  if (row.percentage === null) return 'NO_MARKS';
  if (row.count < row.expected) return 'INCOMPLETE';
  if (policy.pass_percentage === null) return 'RECORDED';
  return row.percentage >= policy.pass_percentage ? 'PASSED' : 'FAILED';
}

function positions(rows: ResultStanding[]) {
  const sorted = [...rows].sort((a, b) => b.percentage! - a.percentage!);
  const result = new Map<ResultStanding, ResultPosition>();
  let rank = 0;
  for (const [index, row] of sorted.entries()) {
    const sameAsPrevious = index > 0 && sorted[index - 1].percentage === row.percentage;
    if (!sameAsPrevious) rank = index + 1;
    result.set(row, {
      rank,
      tied: sameAsPrevious || sorted[index + 1]?.percentage === row.percentage,
    });
  }
  return result;
}

export function standings(rows: ScoreRow[], exams: ResultExam[]) {
  const examById = new Map(exams.map((exam) => [exam.id, exam]));
  const eligibleByExam = new Map<string, ResultStanding[]>();
  const seen = new Map<string, number>();
  const entries = rows.map((row) => {
    const exam = examById.get(row.exam_id)!;
    const standing: ResultStanding = {
      student_id: row.student_id,
      name: row.name,
      student_code: row.student_code,
      exam_id: exam.id,
      class_id: exam.class_id,
      grade: exam.grade,
      section: exam.section,
      obtained: row.obtained,
      maximum: row.maximum,
      percentage: row.percentage,
      class_position: null,
      school_position: null,
    };
    if (row.percentage !== null && exam.status === 'PUBLISHED' && row.count === row.expected) {
      const eligible = eligibleByExam.get(exam.id) || [];
      eligible.push(standing);
      eligibleByExam.set(exam.id, eligible);
      seen.set(row.student_id, (seen.get(row.student_id) || 0) + 1);
    }
    return { row, standing };
  });
  const schoolEligible: ResultStanding[] = [];
  for (const eligible of eligibleByExam.values()) {
    for (const [student, position] of positions(eligible)) {
      student.class_position = position;
      // A transfer can produce two actual results in one school comparison. Neither is
      // automatically chosen as the student's school result.
      if (seen.get(student.student_id) === 1) schoolEligible.push(student);
    }
  }
  for (const [student, position] of positions(schoolEligible)) student.school_position = position;
  return entries;
}

type StandingEntry = ReturnType<typeof standings>[number];
export function topResults(entries: StandingEntry[], scope: 'class_position' | 'school_position') {
  return entries
    .map((entry) => entry.standing)
    .filter((entry) => (entry[scope]?.rank ?? Infinity) <= 3)
    .sort(
      (a, b) =>
        a[scope]!.rank - b[scope]!.rank ||
        a.name.localeCompare(b.name) ||
        a.student_code.localeCompare(b.student_code),
    );
}

function average(numbers: number[]) {
  return numbers.length
    ? Math.round((100 * numbers.reduce((total, n) => total + n, 0)) / numbers.length) / 100
    : null;
}

export function summarize(exams: ResultExam[], entries: StandingEntry[], policy: ResultPolicy) {
  const byExam = new Map<string, StandingEntry[]>();
  for (const entry of entries) {
    const bucket = byExam.get(entry.row.exam_id) || [];
    bucket.push(entry);
    byExam.set(entry.row.exam_id, bucket);
  }
  return exams.map((exam): ClassResultStatistics => {
    const results = byExam.get(exam.id) || [];
    const scores = results.flatMap(({ row }) => (row.obtained === null ? [] : [row.obtained]));
    const statuses = results.map(({ row }) => resultStatus(row, policy));
    return {
      class_id: exam.class_id,
      exam_id: exam.id,
      grade: exam.grade,
      section: exam.section,
      total: results.length,
      appeared: scores.length,
      passed:
        policy.pass_percentage === null
          ? null
          : statuses.filter((status) => status === 'PASSED').length,
      failed:
        policy.pass_percentage === null
          ? null
          : statuses.filter((status) => status === 'FAILED').length,
      incomplete: statuses.filter((status) => status === 'INCOMPLETE').length,
      average_marks: average(scores),
      average_percentage: average(
        results.flatMap(({ row }) => (row.percentage === null ? [] : [row.percentage])),
      ),
      highest_marks: scores.length ? scores.reduce((a, b) => Math.max(a, b)) : null,
      lowest_marks: scores.length ? scores.reduce((a, b) => Math.min(a, b)) : null,
      toppers: topResults(results, 'class_position'),
    };
  });
}

export function resultDistribution(entries: StandingEntry[]) {
  const ranges = ['Under 20%', '20–<40%', '40–<60%', '60–<80%', '80–100%'].map((name) => ({
    name,
    count: 0,
  }));
  for (const { row } of entries)
    if (row.percentage !== null) ranges[Math.min(4, Math.floor(row.percentage / 20))].count++;
  return ranges;
}
