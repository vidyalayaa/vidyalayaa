import { lazy, Suspense, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AcademicPerformance, AcademicSelection } from '@vidyalayaa/contracts';
import { api, useAuth } from '../../lib/auth';
import { Empty, ErrorState, Loading, PageHeading } from '../../components/common';
import { Button } from '../../components/ui/button';
import { PersonAvatar } from '../profiles/PersonAvatar';
import { ResultFilter } from './ResultFilters';
import { ResultReport, resultNumber } from './StudentResultSheet';
import AcademicGuidancePanel from './AcademicGuidancePanel';
import { StudentResults } from '../students/StudentLearning';

const PerformanceChart = lazy(() => import('./PerformanceChart'));
export const academicPath = '/academic-intelligence';

export function AcademicStudentResults() {
  const [history, setHistory] = useState(false);
  return (
    <>
      <Button
        className="result-print-hidden mb-4"
        variant="outline"
        onClick={() => setHistory(!history)}
      >
        {history ? 'Open report cards and AI analysis' : 'Browse marks by examination and subject'}
      </Button>
      {history ? (
        <StudentResults />
      ) : (
        <>
          <PageHeading
            title="My results"
            description="Review published examination results and plan your next steps."
          />
          <AcademicStudentView />
        </>
      )}
    </>
  );
}

export default function AcademicStudentView({
  student,
  initialExam,
  staff = false,
}: {
  student?: string;
  initialExam?: string;
  staff?: boolean;
}) {
  const { school, me } = useAuth();
  const [session, setSession] = useState('');
  const [exam, setExam] = useState(initialExam ?? '');
  const [view, setView] = useState<'results' | 'analysis' | 'plan'>('results');
  const selection = useQuery({
    queryKey: [school, me?.id, 'academic-selection', student],
    refetchInterval: 60_000,
    queryFn: ({ signal }) =>
      api<AcademicSelection>(
        `${academicPath}/selection${student ? `?student_id=${student}` : ''}`,
        { signal },
      ),
  });
  const sessions = new Map(
    selection.data?.exams.map((item) => [item.session_id, item.session_name]),
  );
  const exams = (selection.data?.exams ?? []).filter(
    (item) => !session || item.session_id === session,
  );
  const selected = exams.find((item) => item.id === exam) ?? exams[0];
  const query = {
    ...(student ? { student_id: student } : {}),
    ...(selected ? { exam_id: selected.id } : {}),
  };
  const performance = useQuery({
    queryKey: [school, me?.id, 'academic-performance', student, selected?.id],
    queryFn: ({ signal }) =>
      api<AcademicPerformance>(`${academicPath}/performance?${new URLSearchParams(query)}`, {
        signal,
      }),
    enabled: Boolean(selected),
    refetchInterval: 60_000,
  });
  if (selection.isLoading) return <AcademicSkeleton />;
  if (selection.error)
    return <ErrorState error={selection.error} retry={() => selection.refetch()} />;
  if (!selection.data?.exams.length)
    return (
      <>
        <Empty
          title="No published results in this selection"
          description="Your School Admin must publish the examination before marks appear here."
        />
        <Button
          variant="outline"
          onClick={() => selection.refetch()}
          disabled={selection.isFetching}
        >
          Refresh results
        </Button>
      </>
    );
  return (
    <>
      <nav
        className="result-print-hidden mb-4 flex flex-wrap gap-2"
        aria-label="Student result views"
      >
        <Button
          variant={view === 'results' ? 'lime' : 'outline'}
          aria-pressed={view === 'results'}
          onClick={() => setView('results')}
        >
          {staff || student ? 'Examination results' : 'My Results'}
        </Button>
        <Button
          variant={view === 'analysis' ? 'lime' : 'outline'}
          aria-pressed={view === 'analysis'}
          onClick={() => setView('analysis')}
        >
          AI Performance Analysis
        </Button>
        {me?.school?.role !== 'teacher' && (
          <Button
            variant={view === 'plan' ? 'lime' : 'outline'}
            aria-pressed={view === 'plan'}
            onClick={() => setView('plan')}
          >
            {student ? 'AI Study Plan' : 'My AI Study Plan'}
          </Button>
        )}
        <Button
          variant="outline"
          disabled={selection.isFetching || performance.isFetching}
          onClick={() => {
            void selection.refetch();
            void performance.refetch();
          }}
        >
          Refresh results
        </Button>
      </nav>
      <div className="result-print-hidden mb-5 grid gap-4 rounded-2xl border border-line bg-surface p-4 sm:grid-cols-2">
        <ResultFilter
          label="Academic session"
          value={session}
          change={(value) => {
            setSession(value);
            setExam('');
          }}
        >
          <option value="">All academic sessions</option>
          {[...sessions].map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </ResultFilter>
        <ResultFilter label="Examination" value={selected?.id ?? ''} change={setExam}>
          {exams.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name} · {item.session_name}
            </option>
          ))}
        </ResultFilter>
      </div>
      {performance.isLoading ? (
        <AcademicSkeleton />
      ) : performance.error ? (
        <ErrorState error={performance.error} retry={() => performance.refetch()} />
      ) : (
        performance.data &&
        selected && (
          <section key={selected.id} aria-label="Published academic performance">
            {staff && (
              <div className="result-print-hidden mb-4 flex items-center gap-3">
                <PersonAvatar
                  kind="student"
                  id={performance.data.profile.id}
                  photo={performance.data.profile.photo}
                  name={performance.data.profile.name}
                />
                <h2 className="font-semibold">{performance.data.profile.name}</h2>
              </div>
            )}
            {view === 'results' ? (
              <ResultReport
                result={performance.data.report}
                scoped={me?.school?.role === 'teacher'}
              />
            ) : (
              <>
                {view === 'analysis' && <CalculatedPerformance data={performance.data} />}
                <AcademicGuidancePanel
                  key={JSON.stringify([
                    performance.data.report.student.percentage,
                    performance.data.subjects,
                    performance.data.trend,
                  ])}
                  query={query}
                  data={performance.data}
                  view={view}
                />
              </>
            )}
          </section>
        )
      )}
    </>
  );
}

export function AcademicSkeleton() {
  return (
    <div
      className="mb-4 space-y-3"
      role="status"
      aria-label="Loading academic performance"
      aria-busy="true"
    >
      {[1, 2, 3].map((item) => (
        <div
          key={item}
          className="h-12 animate-pulse rounded-xl border border-line bg-stone-50 motion-reduce:animate-none"
        />
      ))}
    </div>
  );
}

function CalculatedPerformance({ data }: { data: AcademicPerformance }) {
  const sorted = [...data.subjects].sort((a, b) => b.percentage - a.percentage);
  return (
    <section className="mb-5 rounded-2xl border border-line bg-surface p-4">
      <h2 className="mb-3 font-semibold">Calculated performance</h2>
      {sorted.length > 1 && sorted[0].percentage !== sorted.at(-1)?.percentage && (
        <p className="mb-3 text-sm">
          Highest score in {sorted[0].name}. Lowest score in {sorted.at(-1)?.name}.
        </p>
      )}
      <div className="table-scroll">
        <table aria-label="Subject comparisons">
          <thead>
            <tr>
              <th>Subject</th>
              <th>Score</th>
              <th>Previous</th>
              <th title="Current percentage minus previous percentage">Change</th>
              <th title="Highest minus lowest percentage across comparable exams">Score range</th>
              <th title="Shared with families when enabled and at least five marks are recorded">
                Class average
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <tr key={row.id}>
                <th scope="row">{row.name}</th>
                <td>{resultNumber(row.percentage, '%')}</td>
                <td>{resultNumber(row.previous, '%')}</td>
                <td>{resultNumber(row.change, ' pp')}</td>
                <td>{resultNumber(row.consistency, ' pp')}</td>
                <td>{resultNumber(row.class_average, '%')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.trend.length > 1 ? (
        <div className="mt-5">
          <Suspense fallback={<Loading />}>
            <PerformanceChart
              trend
              title="Comparable examination results"
              points={data.trend.map((item) => ({
                name: `${item.name} · ${item.date}`,
                percentage: item.percentage,
              }))}
            />
          </Suspense>
        </div>
      ) : (
        <p className="mt-3 text-sm text-stone-600">
          There aren’t enough comparable exams to show a trend.
        </p>
      )}
    </section>
  );
}
