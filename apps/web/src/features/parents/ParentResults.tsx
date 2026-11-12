import { useState, lazy, Suspense } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ParentChild, ParentResultsResponse } from '@vidyalayaa/contracts';
import { api, useAuth } from '../../lib/auth';
import { Loading, ErrorState, Empty } from '../../components/common';
import { DateFilters, Metric } from './ParentInsightsControls';
import { schoolToday } from '../calendar/calendar-utils';
const ResultCharts = lazy(() => import('./ResultCharts'));
export default function ParentResults({ child, base }: { child: ParentChild; base: string }) {
  const a = useAuth(),
    today = schoolToday(a.me?.school?.timezone);
  const [range, setRange] = useState({
      from: new Date(Date.parse(today + 'T12:00:00Z') - 364 * 86400000).toISOString().slice(0, 10),
      to: today,
    }),
    [exam, setExam] = useState(''),
    [subject, setSubject] = useState('');
  const params = new URLSearchParams({
    ...range,
    ...(exam ? { exam_id: exam } : {}),
    ...(subject ? { subject_id: subject } : {}),
  });
  const q = useQuery({
    queryKey: [a.school, 'parent-result-insights', child.id, params.toString()],
    queryFn: () => api<ParentResultsResponse>(`${base}/results/insights?${params}`),
  });
  return (
    <>
      <DateFilters
        range={range}
        today={today}
        academicStart={child.enrollment?.session_starts_on}
        onApply={(dates) => {
          setRange(dates);
          setExam('');
          setSubject('');
        }}
      >
        <label className="text-sm">
          Examination
          <select
            className="input mt-1 max-w-xs"
            aria-label="Result examination"
            value={exam}
            onChange={(e) => setExam(e.target.value)}
          >
            <option value="">All examinations</option>
            {q.data?.exams.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Subject
          <select
            className="input mt-1 max-w-xs"
            aria-label="Result subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          >
            <option value="">All subjects</option>
            {q.data?.subjects.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      </DateFilters>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorState error={q.error} retry={() => q.refetch()} />
      ) : q.data && !q.data.data.length ? (
        <Empty
          title="No published results in this selection"
          description="Change the filters or check again after your school publishes marks."
        />
      ) : (
        q.data && (
          <>
            <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Metric
                title="Overall result"
                value={q.data.summary.percentage === null ? '—' : q.data.summary.percentage + '%'}
                detail="Total marks earned ÷ total maximum marks"
              />
              <Metric
                title="Published examinations"
                value={q.data.summary.examinations}
                detail="Examinations with recorded marks"
              />
              <Metric
                title="Subjects"
                value={q.data.subject_chart.length}
                detail="Subjects in your current selection"
              />
              <Metric
                title="Marks earned"
                value={`${q.data.summary.score} / ${q.data.summary.maximum}`}
                detail="Published marks in your current selection"
              />
            </div>
            <Suspense fallback={<Loading />}>
              <ResultCharts data={q.data} />
            </Suspense>
            <p className="my-4 text-sm text-stone-600">
              Charts use percentages to compare examinations with different maximum marks. Only
              published, recorded marks are included; missing marks are not treated as zero.
            </p>
            <div className="max-h-[640px] overflow-auto rounded-2xl border border-line bg-surface">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Published marks for {child.first_name}</caption>
                <thead>
                  <tr>
                    {[
                      'Examination',
                      'Date',
                      'Subject',
                      'Marks',
                      'Maximum marks',
                      'Result',
                      'Remarks',
                    ].map((h) => (
                      <th className="whitespace-nowrap p-4 font-medium" key={h}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {q.data.data.map((r) => (
                    <tr key={r.id} className="border-t border-line">
                      <td className="p-4">{r.examination}</td>
                      <td className="whitespace-nowrap p-4">
                        {r.exam_date || r.result_date + ' (record date)'}
                      </td>
                      <td className="p-4">{r.subject}</td>
                      <td className="p-4">{r.score}</td>
                      <td className="p-4">{r.max_score}</td>
                      <td className="p-4">{Math.round((r.score / r.max_score) * 1000) / 10}%</td>
                      <td className="p-4">{r.remarks || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )
      )}
    </>
  );
}
