import { lazy, Suspense, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, Award, TrendingUp, Trophy } from 'lucide-react';
import type { ResultExam, ResultStanding, SchoolResultAnalytics } from '@vidyalayaa/contracts';
import { api, useAuth } from '../../lib/auth';
import { Badge, Empty, ErrorState, Loading } from '../../components/common';
import { Button } from '../../components/ui/button';
import { ResultFilter, type ResultClass, type ResultSession } from './ResultFilters';
import { positionLabel, resultNumber } from './StudentResultSheet';

const PerformanceChart = lazy(() => import('./PerformanceChart'));
type Drilldown = Pick<ResultStanding, 'class_id' | 'exam_id'> & { student_id?: string };
const classroom = ({ grade, section }: { grade: string; section: string }) =>
  `Class ${grade} · Section ${section}`;

export default function AcademicAnalytics({
  sessions,
  classes,
  openResult,
}: {
  sessions: ResultSession[];
  classes: ResultClass[];
  openResult: (target: Drilldown) => void;
}) {
  const { school, me } = useAuth();
  const [session, setSession] = useState('');
  const [grade, setGrade] = useState('');
  const [classId, setClassId] = useState('');
  const [cohort, setCohort] = useState('');
  const sessionId =
    session || sessions.find((item) => item.is_current)?.id || sessions[0]?.id || '';
  const sections = classes.filter((item) => item.academic_session_id === sessionId);
  const grades = [...new Set(sections.map((item) => item.grade))].sort((a, b) =>
    a.localeCompare(b, 'en', { numeric: true }),
  );
  const exams = useQuery({
    queryKey: [school, 'analytics-examinations', me?.id, sessionId],
    queryFn: ({ signal }) =>
      api<{ data: ResultExam[] }>(`/results/examinations?session_id=${sessionId}`, { signal }),
    enabled: !!sessionId,
  });
  const options = new Map<string, ResultExam>();
  for (const exam of exams.data?.data || []) {
    if ((grade && grade !== exam.grade) || (classId && classId !== exam.class_id)) continue;
    if (!options.has(exam.cohort_id) || exam.status === 'PUBLISHED')
      options.set(exam.cohort_id, exam);
  }
  const choices = [...options.values()];
  const exam =
    options.get(cohort) || choices.find((item) => item.status === 'PUBLISHED') || choices[0];
  const params = new URLSearchParams({ session_id: sessionId, cohort_id: exam?.cohort_id || '' });
  if (grade) params.set('grade', grade);
  if (classId) params.set('class_id', classId);
  const analytics = useQuery({
    queryKey: [school, 'result-analytics', me?.id, params.toString()],
    queryFn: ({ signal }) => api<SchoolResultAnalytics>(`/results/analytics?${params}`, { signal }),
    enabled: !!exam,
  });
  return (
    <>
      <section
        aria-label="Academic analytics filters"
        className="mb-6 grid gap-4 rounded-2xl border border-line bg-surface p-4 sm:grid-cols-2 sm:p-5 lg:grid-cols-4"
      >
        <ResultFilter
          label="Academic session"
          value={sessionId}
          change={(value) => {
            setSession(value);
            setGrade('');
            setClassId('');
            setCohort('');
          }}
        >
          {!sessions.length && <option value="">No academic sessions</option>}
          {sessions.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </ResultFilter>
        <ResultFilter
          label="Examination"
          value={exam?.cohort_id || ''}
          change={setCohort}
          disabled={!choices.length}
        >
          {!choices.length && <option value="">No examinations</option>}
          {choices.map((item) => (
            <option key={item.cohort_id} value={item.cohort_id}>
              {item.name} · {item.exam_type.toLowerCase()} · {item.subject_name || 'Official'}
              {choices.some(
                (other) =>
                  other.cohort_id !== item.cohort_id &&
                  other.name === item.name &&
                  other.exam_type === item.exam_type &&
                  other.subject_name === item.subject_name,
              ) &&
                ` · ${classroom(item)} · ${item.starts_on || item.status} · ${item.id.slice(0, 6)}`}
            </option>
          ))}
        </ResultFilter>
        <ResultFilter
          label="Class"
          value={grade}
          change={(value) => {
            setGrade(value);
            setClassId('');
          }}
        >
          <option value="">All classes</option>
          {grades.map((item) => (
            <option key={item} value={item}>
              Class {item}
            </option>
          ))}
        </ResultFilter>
        <ResultFilter label="Section" value={classId} change={setClassId}>
          <option value="">All sections</option>
          {sections
            .filter((item) => !grade || item.grade === grade)
            .map((item) => (
              <option key={item.id} value={item.id}>
                {classroom(item)}
              </option>
            ))}
        </ResultFilter>
      </section>
      {exams.error ? (
        <ErrorState error={exams.error} retry={() => exams.refetch()} />
      ) : analytics.error ? (
        <ErrorState error={analytics.error} retry={() => analytics.refetch()} />
      ) : exams.isLoading || analytics.isLoading ? (
        <Loading />
      ) : analytics.data ? (
        <AnalyticsOverview
          data={analytics.data}
          filtered={!!(grade || classId)}
          filterClass={(item) => {
            setGrade(item.grade);
            setClassId(item.class_id);
          }}
          openResult={openResult}
        />
      ) : (
        <Empty
          title="No examinations in this selection"
          description="Choose another session, class or section to view its performance."
        />
      )}
    </>
  );
}

function AnalyticsOverview({
  data,
  filtered,
  filterClass,
  openResult,
}: {
  data: SchoolResultAnalytics;
  filtered: boolean;
  filterClass: (target: { grade: string; class_id: string }) => void;
  openResult: (target: Drilldown) => void;
}) {
  const sorted = data.classes
    .filter((item) => item.average_marks !== null)
    .sort((a, b) => b.average_marks! - a.average_marks!);
  const best = sorted.filter((item) => item.average_marks === sorted[0].average_marks);
  const high = data.subjects[0]?.percentage;
  const low = data.subjects.at(-1)?.percentage;
  const namesAt = (value: number | undefined) =>
    data.subjects
      .filter((item) => item.percentage === value)
      .map((item) => item.name)
      .join(', ') || '—';
  return (
    <div className="space-y-6">
      <p className="text-sm text-stone-600">
        Sections with matching exam names and types in the same session are compared together.
        Averages use recorded marks. Ranks and trends use published results, and tied scores share a
        rank.
      </p>
      <div className="grid gap-4 md:grid-cols-3">
        {[
          {
            title: 'Top performing class',
            value: best.map(classroom).join(', ') || '—',
            detail: best.length
              ? resultNumber(best[0].average_marks) + ' average marks'
              : 'Highest average marks',
            Icon: Trophy,
          },
          {
            title: 'Highest performing subject',
            value: namesAt(high),
            detail: high === undefined ? 'Average percentage' : resultNumber(high, '%'),
            Icon: TrendingUp,
          },
          {
            title: 'Lowest performing subject',
            value: namesAt(low),
            detail: low === undefined ? 'Average percentage' : resultNumber(low, '%'),
            Icon: Award,
          },
        ].map(({ title, value, detail, Icon }) => (
          <section
            className="min-w-0 rounded-2xl border border-line bg-surface p-4 sm:p-5"
            key={title}
          >
            <span className="inline-flex rounded-xl bg-lime-100 p-2 text-lime-950">
              <Icon size={18} />
            </span>
            <h2 className="mt-3 text-sm font-medium text-stone-600">{title}</h2>
            <p className="mt-1 break-words text-lg font-semibold">{value}</p>
            <p className="mt-1 text-xs text-stone-600">{detail}</p>
          </section>
        ))}
      </div>
      <section className="rounded-2xl border border-line bg-surface p-4 sm:p-5">
        <h2 className="font-semibold">Class-wise statistics</h2>
        <p className="mt-1 text-sm text-stone-600">
          Appeared counts students with recorded scores.{' '}
          {data.pass_percentage === null
            ? 'Set an approved grading policy to calculate passed and failed counts.'
            : `Pass threshold is ${data.pass_percentage}%. Incomplete results are classified separately.`}
        </p>
        <div className="table-scroll mt-4">
          <table aria-label="Class-wise statistics">
            <thead>
              <tr>
                <th>Class and section</th>
                <th>Total</th>
                <th>Appeared</th>
                <th>Passed</th>
                <th>Failed</th>
                <th>Incomplete</th>
                <th>Average marks</th>
                <th>Average %</th>
                <th>Highest marks</th>
                <th>Lowest marks</th>
              </tr>
            </thead>
            <tbody>
              {data.classes.map((item) => (
                <tr key={item.exam_id}>
                  <th scope="row">
                    <Button size="sm" variant="ghost" onClick={() => filterClass(item)}>
                      {classroom(item)} <ArrowUpRight size={14} />
                    </Button>
                  </th>
                  <td>{item.total}</td>
                  <td>{item.appeared}</td>
                  <td>{resultNumber(item.passed)}</td>
                  <td>{resultNumber(item.failed)}</td>
                  <td>{item.incomplete}</td>
                  <td>{resultNumber(item.average_marks)}</td>
                  <td>{resultNumber(item.average_percentage, '%')}</td>
                  <td>{resultNumber(item.highest_marks)}</td>
                  <td>{resultNumber(item.lowest_marks)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <ChartPanel
          title="Class performance comparison"
          detail="Average percentage by class and section."
          points={data.classes.map((item) => ({
            name: classroom(item),
            percentage: item.average_percentage,
          }))}
        />
        <ChartPanel
          title="Average marks by class"
          detail="Raw totals reflect each examination’s available marks."
          points={data.classes.map((item) => ({
            name: classroom(item),
            marks: item.average_marks,
          }))}
          metric="marks"
        />
        <ChartPanel
          title="Performance distribution"
          detail="Percentage bands for students with recorded marks."
          points={data.distribution}
          metric="count"
        />
        <ChartPanel
          title="Subject-wise analysis"
          detail="Average percentage across recorded subject marks."
          points={data.subjects}
        />
        <ChartPanel
          title="Exam comparison"
          detail="Published exam averages in this session, for the selected assessment type."
          points={data.exam_comparison}
          trend
        />
        <ChartPanel
          title="Academic session trends"
          detail="Published results across sessions for the selected assessment type."
          points={data.session_trend}
          trend
        />
      </div>
      <section className="rounded-2xl border border-line bg-surface p-4 sm:p-5">
        <h2 className="font-semibold">Overall school toppers</h2>
        {filtered && (
          <p className="mt-1 text-sm text-stone-600">
            School-wide top ranks within the selected classes.
          </p>
        )}
        <Toppers students={data.school_toppers} scope="school_position" openResult={openResult} />
      </section>
      <section aria-label="Top students by class and section">
        <h2 className="mb-3 text-lg font-semibold">Top 3 students by class and section</h2>
        <div className="grid gap-4 lg:grid-cols-2">
          {data.classes.map((item) => (
            <section
              key={item.exam_id}
              className="min-w-0 rounded-2xl border border-line bg-surface p-4 sm:p-5"
            >
              <h3 className="font-semibold">{classroom(item)}</h3>
              <Button size="sm" variant="outline" className="mt-2" onClick={() => openResult(item)}>
                View section results
              </Button>
              <Toppers students={item.toppers} scope="class_position" openResult={openResult} />
            </section>
          ))}
        </div>
      </section>
    </div>
  );
}

function Toppers({
  students,
  scope,
  openResult,
}: {
  students: ResultStanding[];
  scope: 'school_position' | 'class_position';
  openResult: (target: Drilldown) => void;
}) {
  if (!students.length)
    return (
      <p className="mt-3 text-sm text-stone-600">
        No qualifying published results in this selection.
      </p>
    );
  return (
    <ul className="mt-3 grid gap-2">
      {students.map((student) => (
        <li key={`${student.exam_id}:${student.student_id}`}>
          <button
            type="button"
            className="flex w-full flex-wrap items-center gap-3 rounded-xl border border-line bg-stone-50 p-3 text-left hover:bg-lime-50 focus-visible:outline-2 focus-visible:outline-lime-700"
            onClick={() => openResult(student)}
          >
            <span
              aria-hidden="true"
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-lime-100 text-sm font-semibold text-lime-950"
            >
              {student.name
                .split(/\s+/)
                .slice(0, 2)
                .map((part) => part[0])
                .join('')
                .toUpperCase()}
            </span>
            <span className="min-w-0 flex-1 break-words text-sm">
              <strong>{student.name}</strong>
              <span className="block text-xs text-stone-600">
                {student.student_code} · {classroom(student)}
              </span>
            </span>
            <span className="text-xs text-stone-700">
              {resultNumber(student.obtained)} / {resultNumber(student.maximum)} ·{' '}
              {resultNumber(student.percentage, '%')}
            </span>
            <Badge>{`Rank ${positionLabel(student[scope])}`}</Badge>
          </button>
        </li>
      ))}
    </ul>
  );
}

function ChartPanel({
  title,
  detail,
  points,
  metric,
  trend,
}: {
  title: string;
  detail: string;
  points: { name: string; percentage?: number | null; count?: number; marks?: number | null }[];
  metric?: 'count' | 'marks';
  trend?: boolean;
}) {
  return (
    <section className="min-w-0 rounded-2xl border border-line bg-surface p-4 sm:p-5">
      <h2 className="font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-stone-600">{detail}</p>
      <Suspense fallback={<Loading />}>
        <PerformanceChart title={title} points={points} metric={metric} trend={trend} />
      </Suspense>
    </section>
  );
}
