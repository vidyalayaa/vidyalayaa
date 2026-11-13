import type {
  AcademicCohort,
  AcademicPerformance,
  AcademicSelection,
  AcademicStudent,
  AcademicTrend,
  ResultExam,
  ResultPolicy,
  ResultStatus,
} from '@vidyalayaa/contracts';
import type { Tx } from '../../lib/db.js';
import { notFound } from '../../lib/errors.js';
import { gradeFor, resultSchool, resultStatus, standings } from './result-analytics.js';

export interface PublishedMark {
  exam_id: string;
  student_id: string;
  subject_id: string;
  subject: string;
  score: number;
  maximum: number;
  remarks: string | null;
  class_id: string;
  grade: string;
  section: string;
  session_id: string;
  session_name: string;
  exam: string;
  exam_type: string;
  kind: ResultExam['assessment_kind'];
  exam_date: string;
  starts_on: string | null;
  created_at: string;
}

type Profile = AcademicStudent & { code: string };
export const rounded = (value: number) => Math.round(value * 100) / 100;
function average(values: number[]) {
  return values.length ? rounded(values.reduce((a, b) => a + b, 0) / values.length) : null;
}
function group<T>(items: T[], key: (item: T) => string) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const id = key(item);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id)!.push(item);
  }
  return groups;
}

export async function academicProfiles(tx: Tx, school: string, student: string | null) {
  return (
    await tx.query<Profile>(
      `SELECT id,concat_ws(' ',first_name,last_name) AS name,student_code AS code,
       profile_photo_id AS photo FROM students WHERE school_id=$1 AND ($2::uuid IS NULL OR id=$2)
       ORDER BY first_name,last_name,id`,
      [school, student],
    )
  ).rows;
}

export async function publishedMarks(tx: Tx, school: string, student: string | null) {
  return (
    await tx.query<PublishedMark>(
      `SELECT exam_id,student_id,subject_id,subject,score,maximum,remarks,class_id,grade,section,
        session_id,session_name,exam,exam_type,kind,exam_date::text,starts_on::text,
        to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') AS created_at
        FROM app.published_academic_marks($1,$2)
        ORDER BY exam_date DESC,created_at DESC,exam,exam_id,subject,subject_id,student_id`,
      [school, student],
    )
  ).rows;
}

function examInfo(row: PublishedMark): ResultExam {
  return {
    id: row.exam_id,
    cohort_id: JSON.stringify([
      row.session_id,
      row.exam.trim().replace(/\s+/g, ' ').toLowerCase(),
      row.exam_type,
      row.kind,
      row.kind === 'SUBJECT_TEST' ? row.subject.trim().toLowerCase() : null,
    ]),
    class_id: row.class_id,
    session_id: row.session_id,
    session_name: row.session_name,
    grade: row.grade,
    section: row.section,
    name: row.exam,
    exam_type: row.exam_type,
    assessment_kind: row.kind,
    subject_name: row.kind === 'SUBJECT_TEST' ? row.subject : null,
    max_score: row.maximum,
    starts_on: row.starts_on,
    status: 'PUBLISHED',
  };
}

export function academicSelection(rows: PublishedMark[], profiles: Profile[]): AcademicSelection {
  const students = new Set(rows.map((row) => row.student_id));
  const exams = [...group(rows, (row) => row.exam_id).values()].map(([row]) => examInfo(row));
  const duplicates = group(exams, (exam) => JSON.stringify([exam.class_id, exam.cohort_id]));
  for (const entries of duplicates.values())
    if (entries.length > 1) for (const exam of entries) exam.cohort_id = exam.id;
  return {
    exams,
    subjects: [...group(rows, (row) => row.subject_id).values()]
      .map(([row]) => ({ id: row.subject_id, name: row.subject }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    students: profiles
      .filter((profile) => students.has(profile.id))
      .map(({ id, name, photo }) => ({ id, name, photo })),
  };
}

function percentage(marks: PublishedMark[]) {
  return rounded(
    (100 * marks.reduce((total, mark) => total + mark.score, 0)) /
      marks.reduce((total, mark) => total + mark.maximum, 0),
  );
}

function comparable(mark: PublishedMark, current: PublishedMark) {
  return (
    mark.exam_type === current.exam_type &&
    mark.kind === current.kind &&
    mark.grade === current.grade &&
    (mark.kind !== 'SUBJECT_TEST' || mark.subject_id === current.subject_id)
  );
}

function older(mark: PublishedMark, current: PublishedMark) {
  return (
    comparable(mark, current) &&
    (mark.exam_date < current.exam_date ||
      (mark.exam_date === current.exam_date &&
        !mark.starts_on &&
        !current.starts_on &&
        mark.created_at < current.created_at))
  );
}

function sameSubjects(first: PublishedMark[], second: PublishedMark[]) {
  return (
    first.length === second.length &&
    first.every((mark) => second.some((other) => other.subject_id === mark.subject_id))
  );
}

export async function individualPerformance(
  tx: Tx,
  school: string,
  id: string,
  examId: string | undefined,
  role: string,
): Promise<AcademicPerformance> {
  const [profile] = await academicProfiles(tx, school, id);
  if (!profile) throw notFound();
  const rows = await publishedMarks(tx, school, id);
  const selected = examId ?? rows[0]?.exam_id;
  const current = rows.filter((mark) => mark.exam_id === selected);
  if (!current.length) throw notFound();
  const exam = examInfo(current[0]);
  const { name, policy } = await resultSchool(tx, school);
  const expected = (
    await tx.query<{ subject_id: string; name: string }>(
      'SELECT * FROM app.academic_expected_subjects($1,$2,$3) ORDER BY name,subject_id',
      [school, id, exam.id],
    )
  ).rows;
  const benchmarks = (
    await tx.query<{
      class_rank: number | null;
      class_tied: boolean;
      school_rank: number | null;
      school_tied: boolean;
      averages: Record<string, number>;
    }>('SELECT * FROM app.academic_benchmarks($1,$2,$3)', [school, id, exam.id])
  ).rows[0];
  const history = rows.filter((mark) => older(mark, current[0]));
  const trend: AcademicTrend[] = [...group([...current, ...history], (mark) => mark.exam_id)]
    .filter(([, marks]) => sameSubjects(current, marks))
    .map(([exam_id, marks]) => ({
      exam_id,
      name: marks[0].exam,
      date: marks[0].exam_date,
      percentage: percentage(marks),
    }))
    .reverse();
  const subjects = current.map((mark) => {
    const scores = history
      .filter((item) => item.subject_id === mark.subject_id)
      .map((item) => percentage([item]));
    const currentPercentage = percentage([mark]);
    const prior = scores[0] ?? null;
    const sample = [currentPercentage, ...scores];
    return {
      id: mark.subject_id,
      name: mark.subject,
      percentage: currentPercentage,
      previous: prior,
      change: prior === null ? null : rounded(currentPercentage - prior),
      class_average: benchmarks?.averages[mark.subject_id] ?? null,
      consistency: sample.length > 1 ? rounded(Math.max(...sample) - Math.min(...sample)) : null,
      assessments: sample.length,
    };
  });
  const score = scoreRow(current, profile, expected.length);
  const limited =
    role === 'teacher' &&
    !(
      await tx.query<{ full: boolean }>('SELECT app.is_class_teacher($1,$2) AS full', [
        school,
        exam.class_id,
      ])
    ).rows[0]?.full;
  return {
    profile: { id: profile.id, name: profile.name, photo: profile.photo },
    report: {
      school_name: name,
      exam,
      student: {
        student_id: id,
        name: profile.name,
        student_code: profile.code,
        exam_id: exam.id,
        class_id: exam.class_id,
        grade: exam.grade,
        section: exam.section,
        obtained: score.obtained,
        maximum: score.maximum,
        percentage: score.percentage,
        class_position: benchmarks?.class_rank
          ? { rank: benchmarks.class_rank, tied: benchmarks.class_tied }
          : null,
        school_position: benchmarks?.school_rank
          ? { rank: benchmarks.school_rank, tied: benchmarks.school_tied }
          : null,
      },
      status: resultStatus(score, limited ? { ...policy, pass_percentage: null } : policy),
      grade: !limited && score.count === score.expected ? gradeFor(policy, score.percentage) : null,
      recorded_maximum: score.recorded_maximum,
      subjects: expected.map((subject) => {
        const mark = current.find((entry) => entry.subject_id === subject.subject_id);
        const value = mark ? percentage([mark]) : null;
        return {
          ...subject,
          maximum: exam.max_score,
          percentage: value,
          score: mark?.score ?? null,
          grade: gradeFor(policy, value),
          remarks: mark?.remarks ?? null,
        };
      }),
    },
    subjects,
    trend,
  };
}

function scoreRow(marks: PublishedMark[], profile: Profile, expected: number) {
  return {
    exam_id: marks[0].exam_id,
    student_id: marks[0].student_id,
    name: profile.name,
    student_code: profile.code,
    count: marks.length,
    expected,
    obtained: marks.reduce((total, mark) => total + mark.score, 0),
    maximum: expected * marks[0].maximum,
    recorded_maximum: marks.length * marks[0].maximum,
    percentage: percentage(marks),
  };
}

export interface AcademicFilters {
  session_id?: string;
  exam_id?: string;
  grade?: string;
  class_id?: string;
  subject_id?: string;
  student_id?: string;
}

export function academicCohort(
  all: PublishedMark[],
  profiles: Profile[],
  policy: ResultPolicy,
  filters: AcademicFilters,
  teacher = false,
): AcademicCohort {
  const byProfile = new Map(profiles.map((profile) => [profile.id, profile]));
  const marks = all.filter((row) => byProfile.has(row.student_id));
  const selected = marks.find((row) => row.exam_id === filters.exam_id);
  if (filters.exam_id && !selected) throw notFound();
  const exams = academicSelection(marks, []).exams;
  const byExam = new Map(exams.map((exam) => [exam.id, exam]));
  const broad = marks.filter(
    (row) =>
      (!filters.session_id || row.session_id === filters.session_id) &&
      (!filters.grade || row.grade === filters.grade) &&
      (!filters.class_id || row.class_id === filters.class_id) &&
      (!filters.subject_id || row.subject_id === filters.subject_id) &&
      (!selected || byExam.get(row.exam_id)?.cohort_id === byExam.get(selected.exam_id)?.cohort_id),
  );
  const matching = broad.filter(
    (row) => !filters.student_id || row.student_id === filters.student_id,
  );
  const expected = new Map(
    [...group(marks, (mark) => mark.exam_id)].map(([id, rows]) => [
      id,
      new Set(rows.map((row) => row.subject_id)).size,
    ]),
  );
  const scores = (rows: PublishedMark[]) =>
    [...group(rows, (row) => JSON.stringify([row.exam_id, row.student_id])).values()].map((items) =>
      scoreRow(
        items,
        byProfile.get(items[0].student_id)!,
        filters.subject_id ? 1 : expected.get(items[0].exam_id)!,
      ),
    );
  const ranks = standings(scores(filters.subject_id || teacher ? [] : marks), exams);
  const rankMap = new Map(
    ranks.map((entry) => [
      JSON.stringify([entry.row.exam_id, entry.row.student_id]),
      entry.standing,
    ]),
  );
  const history = group(marks, (row) => row.student_id);
  const scoreEntries = scores(matching);
  const effectivePolicy =
    teacher || filters.subject_id ? { ...policy, pass_percentage: null } : policy;
  const statuses = new Map<string, Set<ResultStatus>>();
  for (const entry of scoreEntries) {
    const recorded = statuses.get(entry.student_id) ?? new Set<ResultStatus>();
    recorded.add(resultStatus(entry, effectivePolicy));
    statuses.set(entry.student_id, recorded);
  }
  function points(
    rows: PublishedMark[],
    key: (mark: PublishedMark) => string,
    name: (mark: PublishedMark) => string,
  ) {
    return [...group(rows, key)]
      .map(([id, entries]) => ({
        id,
        name: name(entries[0]),
        percentage: percentage(entries),
        count: entries.length,
      }))
      .sort((a, b) => b.percentage - a.percentage || a.name.localeCompare(b.name));
  }
  const standingsRows = [
    ...group(matching, (row) => JSON.stringify([row.exam_id, row.student_id])).entries(),
  ]
    .map(([key, items]) => {
      const mark = items[0];
      const standing = rankMap.get(key);
      const score = scoreRow(
        items,
        byProfile.get(mark.student_id)!,
        filters.subject_id ? 1 : expected.get(mark.exam_id)!,
      );
      const prior = [
        ...group(
          (history.get(mark.student_id) || []).filter(
            (m) => older(m, mark) && (!filters.subject_id || m.subject_id === filters.subject_id),
          ),
          (m) => m.exam_id,
        ).values(),
      ].find((previous) => sameSubjects(items, previous));
      return {
        student_id: mark.student_id,
        name: score.name,
        exam_id: mark.exam_id,
        class_id: mark.class_id,
        percentage: score.percentage,
        status: resultStatus(score, effectivePolicy),
        class_rank: standing?.class_position?.rank ?? null,
        school_rank: standing?.school_position?.rank ?? null,
        change: prior ? rounded(score.percentage - percentage(prior)) : null,
      };
    })
    .sort((a, b) => b.percentage - a.percentage || a.name.localeCompare(b.name));
  const values = standingsRows.map((row) => row.percentage);
  const byClass = group(standingsRows, (row) => row.class_id);
  const classScores = group(scoreEntries, (row) => byExam.get(row.exam_id)!.class_id);
  const classes = points(
    matching,
    (m) => m.class_id,
    (m) => `Class ${m.grade} · ${m.section} · ${m.session_name}`,
  ).map((item) => {
    const changes = (byClass.get(item.id) ?? []).flatMap((row) =>
      row.change === null ? [] : [row.change],
    );
    return {
      ...item,
      average_marks: average(classScores.get(item.id)!.map((row) => row.obtained))!,
      average_change: average(changes),
      improved: changes.filter((value) => value > 0).length,
      compared: changes.length,
    };
  });
  return {
    average: average(values),
    appeared: statuses.size,
    passed:
      effectivePolicy.pass_percentage === null
        ? null
        : [...statuses.values()].filter((s) => s.size === 1 && s.has('PASSED')).length,
    failed:
      effectivePolicy.pass_percentage === null
        ? null
        : [...statuses.values()].filter((s) => s.has('FAILED')).length,
    highest: values[0] ?? null,
    lowest: values.at(-1) ?? null,
    distribution: ['Under 20%', '20–<40%', '40–<60%', '60–<80%', '80–100%'].map((name, i) => ({
      name,
      count: values.filter((value) => Math.min(4, Math.floor(value / 20)) === i).length,
    })),
    classes,
    subjects: points(
      matching,
      (m) => m.subject_id,
      (m) => m.subject,
    ),
    exams: points(
      matching,
      (m) => byExam.get(m.exam_id)!.cohort_id,
      (m) => `${m.exam} · ${m.session_name}`,
    ),
    sessions: points(
      matching,
      (m) => m.session_id,
      (m) => m.session_name,
    ),
    standings: standingsRows,
  };
}
