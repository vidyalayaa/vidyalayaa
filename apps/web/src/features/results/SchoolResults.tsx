import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { Page } from '@vidyalayaa/contracts';
import { api, useAuth } from '../../lib/auth';
import { PageHeading, Empty, ErrorState, Loading } from '../../components/common';
import { Button } from '../../components/ui/button';
import { ResourceScreen } from '../resources/ResourceScreen';

async function choices(path: string, signal: AbortSignal) {
  const rows: Record<string, unknown>[] = [];
  for (let page = 1; ; page++) {
    const result = await api<Page>(
      `${path}${path.includes('?') ? '&' : '?'}page_size=100&page=${page}`,
      { signal },
    );
    rows.push(...result.data);
    if (!result.data.length || rows.length >= result.total) return rows;
  }
}
export default function SchoolResults() {
  const a = useAuth(),
    [classId, setClassId] = useState(''),
    [examId, setExamId] = useState('');
  const classes = useQuery({
    queryKey: [a.school, 'results-classes'],
    queryFn: ({ signal }) => choices('/resources/classes', signal),
  });
  const classroom = classes.data?.find((c) => c.id === classId);
  const exams = useQuery({
    queryKey: [a.school, 'results-exams', classId],
    queryFn: ({ signal }) => choices(`/resources/exams?class_id=${classId}`, signal),
    enabled: !!classroom,
  });
  const exam = exams.data?.find((e) => e.id === examId);
  const classLabel = classroom
    ? `Class ${classroom.grade} · Section ${classroom.section} · ${classroom.academic_session_label}`
    : '';
  return (
    <>
      <PageHeading
        title="Results"
        description="Choose the class and section, then its examination, and record marks for its students."
        actions={
          a.me?.school?.permissions.includes('assessments.write') && (
            <Button variant="outline" asChild>
              <Link to="/admin/r/exams">Manage examinations</Link>
            </Button>
          )
        }
      />
      <section
        aria-label="Select results class and examination"
        className="mb-6 grid gap-5 rounded-2xl border border-stone-200 bg-white p-5 sm:grid-cols-2"
      >
        <div>
          <label className="field-label" htmlFor="results-class">
            Class and section
          </label>
          <select
            id="results-class"
            className="input"
            value={classId}
            disabled={classes.isLoading}
            onChange={(e) => {
              setClassId(e.target.value);
              setExamId('');
            }}
          >
            <option value="">Select a class and section</option>
            {classes.data?.map((c) => (
              <option key={String(c.id)} value={String(c.id)}>
                Class {String(c.grade)} · Section {String(c.section)} ·{' '}
                {String(c.academic_session_label)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="field-label" htmlFor="results-exam">
            Examination
          </label>
          <select
            id="results-exam"
            className="input"
            value={examId}
            disabled={!classroom || exams.isLoading || !!exams.error}
            onChange={(e) => setExamId(e.target.value)}
          >
            <option value="">
              {!classroom ? 'Choose a class first' : 'Select an examination'}
            </option>
            {exams.data?.map((e) => (
              <option key={String(e.id)} value={String(e.id)}>
                {String(e.name)} ·{' '}
                {e.assessment_kind === 'SUBJECT_TEST' ? 'Subject test' : 'Official examination'} ·{' '}
                {String(e.status)}
              </option>
            ))}
          </select>
        </div>
      </section>
      {classes.error ? (
        <ErrorState error={classes.error} retry={() => classes.refetch()} />
      ) : classes.isLoading ? (
        <Loading />
      ) : !classroom ? (
        <Empty
          title="Select a class and section"
          description="Each class has its own examinations, subjects and enrolled students."
        />
      ) : exams.error ? (
        <ErrorState error={exams.error} retry={() => exams.refetch()} />
      ) : exams.isLoading ? (
        <Loading />
      ) : !exam ? (
        <Empty
          title={exams.data?.length ? 'Select an examination' : 'No examinations for this class'}
          description="Choose an existing examination or use Manage examinations to create one for this class."
        />
      ) : (
        <div key={`${classId}:${examId}`}>
          <p className="mb-4 text-sm text-stone-600">
            {classLabel} · {String(exam.name)} · Maximum score: {String(exam.max_score)} ·{' '}
            {String(exam.status)}
          </p>
          {exam.status !== 'OPEN' && (
            <p className="notice mb-4">
              This examination is read-only. Open it in Manage examinations before adding or
              changing marks.
            </p>
          )}
          <ResourceScreen resource="marks" assessment={{ classId, classLabel, exam }} />
        </div>
      )}
    </>
  );
}
