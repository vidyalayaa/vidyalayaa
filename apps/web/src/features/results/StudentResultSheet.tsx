import { lazy, Suspense } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Printer } from 'lucide-react';
import type { ResultPosition, ResultStatus, StudentExamResult } from '@vidyalayaa/contracts';
import { api, useAuth } from '../../lib/auth';
import { Badge, Empty, ErrorState, Loading } from '../../components/common';
import { Button } from '../../components/ui/button';

const PerformanceChart = lazy(() => import('./PerformanceChart'));
const statuses: Record<ResultStatus, string> = {
  NO_MARKS: 'No marks recorded',
  INCOMPLETE: 'Incomplete',
  RECORDED: 'Recorded',
  PASSED: 'Passed',
  FAILED: 'Failed',
};
export const positionLabel = (position: ResultPosition | null) =>
  position ? `${position.rank}${position.tied ? ' (tie)' : ''}` : '—';
export const resultNumber = (value: number | null, suffix = '') =>
  value === null ? '—' : `${value.toLocaleString('en-IN', { maximumFractionDigits: 2 })}${suffix}`;

export default function StudentResultSheet({
  examId,
  studentId,
}: {
  examId: string;
  studentId: string;
}) {
  const { school, me } = useAuth();
  const query = useQuery({
    queryKey: [school, 'individual-result', me?.id, examId, studentId],
    queryFn: ({ signal }) =>
      api<StudentExamResult>(`/results/exams/${examId}/students/${studentId}`, { signal }),
  });
  if (query.isLoading) return <Loading />;
  if (query.error) return <ErrorState error={query.error} retry={() => query.refetch()} />;
  if (!query.data) return <Empty title="Result unavailable" />;
  const { exam, student, subjects, school_name, status, grade, recorded_maximum } = query.data;
  return (
    <article
      className="student-result-sheet mb-6 rounded-2xl border border-line bg-surface p-4 sm:p-6"
      aria-label="Student result"
    >
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-stone-600">
            {school_name} · {exam.session_name}
          </p>
          <h2 className="mt-1 text-2xl font-semibold">{student.name}</h2>
          <p className="text-sm text-stone-600">
            {student.student_code} · Class {exam.grade} · Section {exam.section}
          </p>
          <p className="mt-2 font-medium">
            {exam.name} <Badge>{exam.status}</Badge>
          </p>
        </div>
        <Button variant="outline" className="result-print-hidden" onClick={() => window.print()}>
          <Printer size={16} /> Print / Save as PDF
        </Button>
      </header>
      <dl className="my-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[
          ['Total marks', `${resultNumber(student.obtained)} / ${resultNumber(student.maximum)}`],
          ['Percentage', resultNumber(student.percentage, '%')],
          ['Grade', grade ?? '—'],
          ['Result status', statuses[status]],
          ['Class rank', positionLabel(student.class_position)],
          ['School position', positionLabel(student.school_position)],
        ].map(([label, value]) => (
          <div className="rounded-xl bg-stone-50 p-3" key={label}>
            <dt className="text-xs text-stone-600">{label}</dt>
            <dd className="mt-1 font-semibold">{value}</dd>
          </div>
        ))}
      </dl>
      {status === 'INCOMPLETE' && (
        <p className="notice mb-4">
          The percentage uses {resultNumber(recorded_maximum)} available marks from recorded
          subjects.
        </p>
      )}
      <h3 className="mb-2 font-semibold">Subject-wise marks</h3>
      {subjects.length ? (
        <div className="table-scroll">
          <table aria-label="Subject-wise marks">
            <thead>
              <tr>
                <th>Subject</th>
                <th>Obtained</th>
                <th>Maximum</th>
                <th>Percentage</th>
                <th>Grade</th>
                <th>Remarks</th>
              </tr>
            </thead>
            <tbody>
              {subjects.map((subject) => (
                <tr key={subject.subject_id}>
                  <th scope="row">{subject.name}</th>
                  <td>{subject.score === null ? 'Not recorded' : resultNumber(subject.score)}</td>
                  <td>{resultNumber(subject.maximum)}</td>
                  <td>{resultNumber(subject.percentage, '%')}</td>
                  <td>{subject.grade ?? '—'}</td>
                  <td className="whitespace-normal">{subject.remarks || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title="No subjects with recorded marks" />
      )}
      {subjects.some((subject) => subject.score !== null) && (
        <div className="result-print-hidden mt-5">
          <h3 className="font-semibold">Subject performance</h3>
          <Suspense fallback={<Loading />}>
            <PerformanceChart title="Subject performance" points={subjects} />
          </Suspense>
        </div>
      )}
      <p className="mt-4 text-xs text-stone-600">
        Ranks use complete published results and include ties. Grades and pass status use the
        school’s configured policy.
      </p>
    </article>
  );
}
