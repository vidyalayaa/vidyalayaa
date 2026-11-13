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
  return <ResultReport result={query.data} />;
}

export function ResultReport({
  result,
  scoped = false,
}: {
  result: StudentExamResult;
  scoped?: boolean;
}) {
  const { exam, student, subjects, school_name, status, grade, recorded_maximum } = result;
  function download() {
    const rows = [
      ['School', school_name],
      ['Session', exam.session_name],
      ['Exam', exam.name],
      ['Student', student.name],
      ['Student code', student.student_code],
      ['Obtained', student.obtained],
      ['Maximum', student.maximum],
      ['Percentage', student.percentage],
      ['Grade', grade],
      ['Result', statuses[status]],
      ['Class rank', positionLabel(student.class_position)],
      ['School position', positionLabel(student.school_position)],
      ['Subject', 'Obtained', 'Maximum', 'Percentage', 'Grade'],
      ...subjects.map((subject) => [
        subject.name,
        subject.score,
        subject.maximum,
        subject.percentage,
        subject.grade,
      ]),
    ];
    const csv = rows
      .map((row) =>
        row
          .map((cell) => {
            const value = String(cell ?? '');
            const safe = /^[\s]*[=+\-@]/.test(value) ? "'" + value : value;
            return '"' + safe.replace(/"/g, '""') + '"';
          })
          .join(','),
      )
      .join('\r\n');
    const url = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'examination-result.csv';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
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
        <div className="result-print-hidden flex flex-wrap gap-2">
          <Button variant="outline" onClick={download}>
            Download CSV
          </Button>
          <Button variant="outline" onClick={() => window.print()}>
            <Printer size={16} /> Print / Save as PDF
          </Button>
        </div>
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
            <dt
              className="text-xs text-stone-600"
              title={
                label === 'Percentage'
                  ? 'Obtained marks divided by the maximum for recorded subjects.'
                  : undefined
              }
            >
              {label}
            </dt>
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
        {scoped
          ? 'This view includes the marks available to your teaching assignment.'
          : "Ranks use complete published results and include ties. Grades and pass status use the school's configured policy."}
      </p>
    </article>
  );
}
