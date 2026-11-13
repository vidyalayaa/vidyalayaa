import { lazy, Suspense, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { AcademicCohort, AcademicSelection } from '@vidyalayaa/contracts';
import { api, useAuth } from '../../lib/auth';
import { Empty, ErrorState, Loading, PageHeading } from '../../components/common';
import { Button } from '../../components/ui/button';
import { ResultFilter } from './ResultFilters';
import { resultNumber } from './StudentResultSheet';
import AcademicStudentView, { AcademicSkeleton, academicPath } from './AcademicStudentView';

const PerformanceChart = lazy(() => import('./PerformanceChart'));
type Filters = Partial<
  Record<'session_id' | 'exam_id' | 'grade' | 'class_id' | 'subject_id' | 'student_id', string>
>;

export default function AcademicDashboard() {
  const { school, me } = useAuth();
  const role = me?.school?.role;
  const teacher = role === 'teacher';
  const permitted = teacher || role === 'school_admin' || role === 'principal';
  const [filters, setFilters] = useState<Filters>({});
  const [detail, setDetail] = useState<{ student: string; exam: string }>();
  const options = useQuery({
    queryKey: [school, me?.id, 'academic-dashboard-options'],
    queryFn: ({ signal }) => api<AcademicSelection>(`${academicPath}/selection`, { signal }),
    enabled: permitted,
  });
  const active = Object.fromEntries(Object.entries(filters).filter(([, value]) => value));
  const cohort = useQuery({
    queryKey: [school, me?.id, 'academic-cohort', active],
    queryFn: ({ signal }) =>
      api<AcademicCohort>(`${academicPath}/cohort?${new URLSearchParams(active)}`, { signal }),
    enabled: permitted && Boolean(options.data?.exams.length),
  });
  const exams = (options.data?.exams ?? []).filter(
    (exam) => !filters.session_id || exam.session_id === filters.session_id,
  );
  const grades = [...new Set(exams.map((exam) => exam.grade))].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
  const classes = new Map(
    exams
      .filter((exam) => !filters.grade || exam.grade === filters.grade)
      .map((exam) => [
        exam.class_id,
        `Class ${exam.grade} · ${exam.section} · ${exam.session_name}`,
      ]),
  );
  const sessions = new Map(options.data?.exams.map((exam) => [exam.session_id, exam.session_name]));
  const examChoices = new Map(
    exams
      .filter(
        (exam) =>
          (!filters.grade || exam.grade === filters.grade) &&
          (!filters.class_id || exam.class_id === filters.class_id),
      )
      .map((exam) => [exam.cohort_id, exam]),
  );
  function change(field: keyof Filters, value: string) {
    setDetail(undefined);
    setFilters((previous) => ({
      ...previous,
      ...(field === 'session_id' ? { grade: '', class_id: '', exam_id: '' } : {}),
      ...(field === 'grade' ? { class_id: '', exam_id: '' } : {}),
      ...(field === 'class_id' ? { exam_id: '' } : {}),
      [field]: value,
    }));
  }
  const control = (label: string, field: keyof Filters, choices: [string, string][]) => (
    <ResultFilter
      label={label}
      value={filters[field] ?? ''}
      change={(value) => change(field, value)}
    >
      <option value="">All</option>
      {choices.map(([id, name]) => (
        <option key={id} value={id}>
          {name}
        </option>
      ))}
    </ResultFilter>
  );
  if (!permitted)
    return (
      <Empty title="Academic intelligence is available to teaching and school leadership accounts" />
    );
  return (
    <>
      <PageHeading
        title={teacher ? 'Academic Performance & AI Analysis' : 'AI Academic Intelligence'}
        description={
          teacher
            ? 'Review published performance for your teaching assignments.'
            : 'Review published performance across your school.'
        }
        actions={
          role === 'school_admin' && me?.school?.permissions.includes('school.manage') ? (
            <SharingPreference />
          ) : undefined
        }
      />
      {options.isLoading ? (
        <AcademicSkeleton />
      ) : options.error ? (
        <ErrorState error={options.error} retry={() => options.refetch()} />
      ) : !options.data?.exams.length ? (
        <Empty title="No published examination results" />
      ) : (
        <div className="result-print-hidden mb-5 grid gap-4 rounded-2xl border border-line bg-surface p-4 sm:grid-cols-2 xl:grid-cols-3">
          {control('Academic session', 'session_id', [...sessions])}
          {control(
            'Class',
            'grade',
            grades.map((grade) => [grade, grade]),
          )}
          {control('Section', 'class_id', [...classes])}
          {control(
            'Examination',
            'exam_id',
            [...examChoices.values()].map((exam) => [
              exam.id,
              `${exam.name} · ${exam.session_name}`,
            ]),
          )}
          {control(
            'Subject',
            'subject_id',
            options.data.subjects.map((item) => [item.id, item.name]),
          )}
          {control(
            'Student',
            'student_id',
            options.data.students.map((item) => [item.id, item.name]),
          )}
        </div>
      )}
      {detail ? (
        <>
          <Button
            className="result-print-hidden mb-4"
            variant="outline"
            onClick={() => setDetail(undefined)}
          >
            Back to overview
          </Button>
          <AcademicStudentView
            key={detail.student + detail.exam}
            student={detail.student}
            initialExam={detail.exam}
            staff
          />
        </>
      ) : cohort.isLoading ? (
        <AcademicSkeleton />
      ) : cohort.error ? (
        <ErrorState error={cohort.error} retry={() => cohort.refetch()} />
      ) : (
        cohort.data &&
        (cohort.data.appeared ? (
          <>
            <AcademicCohortResults
              key={JSON.stringify(active)}
              data={cohort.data}
              open={(student, exam) => setDetail({ student, exam })}
            />
            <CohortInsights key={JSON.stringify([school, active])} filters={active} />
          </>
        ) : (
          <Empty title="No published marks match these filters" />
        ))
      )}
    </>
  );
}

function SharingPreference() {
  const { school, me } = useAuth();
  const query = useQuery({
    queryKey: [school, me?.id, 'academic-sharing'],
    queryFn: ({ signal }) =>
      api<{ share_class_averages: boolean }>(`${academicPath}/sharing`, { signal }),
  });
  const save = useMutation({
    mutationFn: (share: boolean) =>
      api(`${academicPath}/sharing`, {
        method: 'PUT',
        body: JSON.stringify({ share_class_averages: share }),
      }),
    onSuccess: () => query.refetch(),
  });
  return (
    <div className="space-y-1 text-sm">
      {query.data && (
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={query.data.share_class_averages}
            disabled={save.isPending}
            onChange={(event) => save.mutate(event.target.checked)}
          />
          Share class averages with students and parents
        </label>
      )}
      {save.error && <ErrorState error={save.error} />}
    </div>
  );
}

export function AcademicCohortResults({
  data,
  open,
}: {
  data: AcademicCohort;
  open?: (student: string, exam: string) => void;
}) {
  const [show, setShow] = useState<'all' | 'decline' | 'support' | 'high' | 'class' | 'school'>(
    'all',
  );
  const [page, setPage] = useState(0);
  const rows = data.standings.filter((row) => {
    if (show === 'decline') return row.change !== null && row.change < 0;
    if (show === 'support')
      return row.status === 'FAILED' || (row.change !== null && row.change <= -10);
    if (show === 'high')
      return row.percentage >= 80 && row.change !== null && row.percentage - row.change >= 80;
    if (show === 'class') return row.class_rank !== null && row.class_rank <= 3;
    if (show === 'school') return row.school_rank !== null && row.school_rank <= 3;
    return true;
  });
  const currentPage = Math.min(page, Math.max(0, Math.ceil(rows.length / 25) - 1));
  const classLabels = new Map(data.classes.map((item) => [item.id, item.name]));
  return (
    <>
      <p className="mb-3 text-sm text-stone-600">
        Comparisons use percentages to account for different maximum marks. Pass and fail totals
        count unique students in this selection.
      </p>
      <dl className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {[
          ['Average', resultNumber(data.average, '%')],
          ['Students appeared', data.appeared],
          ['Passed', data.passed ?? '—'],
          ['Failed', data.failed ?? '—'],
          ['Highest', resultNumber(data.highest, '%')],
          ['Lowest', resultNumber(data.lowest, '%')],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl border border-line bg-surface p-3">
            <dt className="text-sm text-stone-600">{label}</dt>
            <dd className="text-xl font-semibold">{value}</dd>
          </div>
        ))}
      </dl>
      {data.classes.length > 1 && (
        <p className="mb-4 text-sm">
          Highest class average <strong>{data.classes[0].name}</strong> · Lowest class average{' '}
          <strong>{data.classes.at(-1)?.name}</strong>
        </p>
      )}
      <div className="mb-5 grid gap-4 lg:grid-cols-2">
        {[
          ['Class averages', data.classes],
          ['Subject averages', data.subjects],
          ['Examination comparison', data.exams],
          ['Session comparison', data.sessions],
        ].map(
          ([title, points]) =>
            typeof title === 'string' &&
            typeof points !== 'string' &&
            points.length > 0 && (
              <section key={title} className="rounded-xl border border-line bg-surface p-4">
                <h2 className="mb-2 font-semibold">{title}</h2>
                <Suspense fallback={<Loading />}>
                  <PerformanceChart title={title} points={points} />
                </Suspense>
              </section>
            ),
        )}
      </div>
      <section className="mb-5 rounded-xl border border-line bg-surface p-4">
        <h2 className="font-semibold">Performance distribution</h2>
        <dl className="my-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
          {data.distribution.map((entry) => (
            <div key={entry.name}>
              <dt className="text-sm text-stone-600">{entry.name}</dt>
              <dd>{entry.count}</dd>
            </div>
          ))}
        </dl>
        <details>
          <summary className="cursor-pointer text-sm font-medium">Class average marks</summary>
          <ul className="mt-2 space-y-1 text-sm">
            {data.classes.map((entry) => (
              <li key={entry.id}>
                {entry.name} · {resultNumber(entry.average_marks)} marks ·{' '}
                {resultNumber(entry.percentage, '%')}
                {entry.average_change !== null && (
                  <>
                    {' '}
                    · {resultNumber(entry.average_change, ' pp')} average change ({entry.improved}/
                    {entry.compared} comparable results improved)
                  </>
                )}
              </li>
            ))}
          </ul>
        </details>
      </section>
      <section className="mb-5 rounded-xl border border-line bg-surface p-4">
        <h2 className="mb-3 font-semibold">Student performance</h2>
        <div className="mb-3 max-w-xs">
          <ResultFilter
            label="Performance group"
            value={show}
            change={(value) => {
              setShow(value as typeof show);
              setPage(0);
            }}
          >
            <option value="all">All published results</option>
            <option value="decline">Declining scores</option>
            <option value="support">May need support</option>
            <option value="high">Consistently high scores</option>
            {data.standings.some((row) => row.class_rank !== null) && (
              <option value="class">Top three class positions</option>
            )}
            {data.standings.some((row) => row.school_rank !== null) && (
              <option value="school">Top three school positions</option>
            )}
          </ResultFilter>
        </div>
        {rows.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Student</th>
                  <th>Class</th>
                  <th>Score</th>
                  <th>Change</th>
                  <th>Class rank</th>
                  <th>School rank</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(currentPage * 25, (currentPage + 1) * 25).map((row) => (
                  <tr key={row.student_id + row.exam_id}>
                    <th scope="row">
                      {open ? (
                        <button
                          className="font-medium underline"
                          onClick={() => open(row.student_id, row.exam_id)}
                        >
                          {row.name}
                        </button>
                      ) : (
                        row.name
                      )}
                    </th>
                    <td>{classLabels.get(row.class_id)}</td>
                    <td>{resultNumber(row.percentage, '%')}</td>
                    <td>{resultNumber(row.change, ' pp')}</td>
                    <td>{row.class_rank ?? '—'}</td>
                    <td>{row.school_rank ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No results in this group" />
        )}
        {rows.length > 25 && (
          <div className="mt-3 flex items-center gap-2">
            <Button
              variant="outline"
              disabled={currentPage === 0}
              onClick={() => setPage(currentPage - 1)}
            >
              Previous
            </Button>
            <span className="text-sm">
              Page {currentPage + 1} of {Math.ceil(rows.length / 25)}
            </span>
            <Button
              variant="outline"
              disabled={(currentPage + 1) * 25 >= rows.length}
              onClick={() => setPage(currentPage + 1)}
            >
              Next
            </Button>
          </div>
        )}
      </section>
    </>
  );
}

function CohortInsights({ filters }: { filters: Filters }) {
  const insights = useMutation({
    mutationFn: () =>
      api<{ summary: string; insights: string[] }>(`${academicPath}/cohort/insights`, {
        method: 'POST',
        body: JSON.stringify(filters),
      }),
  });
  return (
    <section className="rounded-xl border border-line bg-surface p-4">
      <h2 className="mb-2 font-semibold">AI-generated academic insights</h2>
      {insights.error ? (
        <ErrorState error={insights.error} retry={() => insights.mutate()} />
      ) : insights.data ? (
        <>
          <p className="mb-2 text-sm">{insights.data.summary}</p>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {insights.data.insights.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </>
      ) : (
        <Button variant="outline" onClick={() => insights.mutate()} disabled={insights.isPending}>
          {insights.isPending ? 'Generating insights…' : 'Generate insights'}
        </Button>
      )}
    </section>
  );
}
