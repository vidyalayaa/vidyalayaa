import { lazy, Suspense, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { Page } from '@vidyalayaa/contracts';
import { api, useAuth } from '../../lib/auth';
import { PageHeading, Empty, ErrorState, Loading } from '../../components/common';
import { Button } from '../../components/ui/button';
import RecordSelect from '../../components/RecordSelect';
import { ResourceScreen } from '../resources/ResourceScreen';
import { schoolPath } from '../../lib/portals';
import { ResultFilter, type ResultClass, type ResultSession } from './ResultFilters';
import StudentResultSheet from './StudentResultSheet';

const AcademicAnalytics = lazy(() => import('./AcademicAnalytics'));
const ResultPolicyDialog = lazy(() => import('./ResultPolicyDialog'));
const blankSelection = { session: '', grade: '', classId: '', examId: '', studentId: '' };

async function choices<T>(path: string, signal: AbortSignal) {
  const rows: T[] = [];
  for (let page = 1; ; page++) {
    const result = await api<Page<T>>(
      `${path}${path.includes('?') ? '&' : '?'}page_size=100&page=${page}`,
      { signal },
    );
    rows.push(...result.data);
    if (!result.data.length || rows.length >= result.total) return rows;
  }
}

export default function SchoolResults() {
  const { school, me } = useAuth();
  const role = me?.school?.role;
  const [selection, setSelection] = useState(blankSelection);
  const [view, setView] = useState<'results' | 'analytics'>('results');
  const [policy, setPolicy] = useState(false);
  const canManageExams = me?.school?.permissions.includes('assessments.write');
  const canRecordMarks = me?.school?.permissions.includes('marks.write');
  const canConfigurePolicy =
    role === 'school_admin' && me?.school?.permissions.includes('school.manage');
  const classes = useQuery({
    queryKey: [school, 'results-classes', me?.id],
    queryFn: ({ signal }) => choices<ResultClass>('/resources/classes', signal),
  });
  const sessions = useQuery({
    queryKey: [school, 'results-sessions', me?.id],
    queryFn: ({ signal }) => choices<ResultSession>('/resources/academic_sessions', signal),
  });
  const classroom = classes.data?.find((item) => item.id === selection.classId);
  const exams = useQuery({
    queryKey: [school, 'results-exams', me?.id, selection.classId],
    queryFn: ({ signal }) =>
      choices<Record<string, unknown>>(`/resources/exams?class_id=${selection.classId}`, signal),
    enabled: view === 'results' && !!classroom,
  });
  const exam = exams.data?.find((item) => item.id === selection.examId);
  const sections = (classes.data || []).filter(
    (item) => !selection.session || item.academic_session_id === selection.session,
  );
  const grades = [...new Set(sections.map((item) => item.grade))].sort((a, b) =>
    a.localeCompare(b, 'en', { numeric: true }),
  );
  const classLabel = classroom
    ? `Class ${classroom.grade} · Section ${classroom.section} · ${classroom.academic_session_label}`
    : '';
  const loadingError = classes.error ?? sessions.error;

  return (
    <>
      <PageHeading
        title="Results"
        description="Review student marks and compare performance across your school."
        actions={
          <>
            {canConfigurePolicy && (
              <Button variant="outline" onClick={() => setPolicy(true)}>
                Grading policy
              </Button>
            )}
            <Button variant="outline" asChild>
              <Link to={schoolPath('/r/exams', role)}>
                {canManageExams ? 'Manage examinations' : 'View examinations'}
              </Link>
            </Button>
          </>
        }
      />
      <nav className="results-navigation mb-5 flex flex-wrap gap-2" aria-label="Results views">
        <Button
          type="button"
          variant={view === 'results' ? 'lime' : 'outline'}
          aria-pressed={view === 'results'}
          onClick={() => setView('results')}
        >
          Student results
        </Button>
        <Button
          type="button"
          variant={view === 'analytics' ? 'lime' : 'outline'}
          aria-pressed={view === 'analytics'}
          onClick={() => setView('analytics')}
        >
          Academic analytics
        </Button>
      </nav>
      {loadingError ? (
        <ErrorState
          error={loadingError}
          retry={() => {
            void classes.refetch();
            void sessions.refetch();
          }}
        />
      ) : view === 'analytics' ? (
        classes.isLoading || sessions.isLoading ? (
          <Loading />
        ) : (
          <Suspense fallback={<Loading />}>
            <AcademicAnalytics
              sessions={sessions.data || []}
              classes={classes.data || []}
              openResult={(target) => {
                const found = classes.data?.find((item) => item.id === target.class_id);
                setSelection({
                  session: found?.academic_session_id || '',
                  grade: found?.grade || '',
                  classId: target.class_id,
                  examId: target.exam_id,
                  studentId: target.student_id || '',
                });
                setView('results');
                document.getElementById('main-content')?.focus({ preventScroll: true });
                window.scrollTo(0, 0);
              }}
            />
          </Suspense>
        )
      ) : (
        <>
          <section
            aria-label="Student result filters"
            className="mb-6 grid gap-4 rounded-2xl border border-line bg-surface p-4 sm:grid-cols-2 sm:p-5 xl:grid-cols-5"
          >
            <ResultFilter
              label="Academic session"
              value={selection.session}
              change={(session) => setSelection({ ...blankSelection, session })}
            >
              <option value="">All academic sessions</option>
              {sessions.data?.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </ResultFilter>
            <ResultFilter
              label="Class"
              value={selection.grade}
              change={(grade) =>
                setSelection({ ...blankSelection, session: selection.session, grade })
              }
            >
              <option value="">All classes</option>
              {grades.map((grade) => (
                <option key={grade} value={grade}>
                  Class {grade}
                </option>
              ))}
            </ResultFilter>
            <ResultFilter
              id="results-class"
              label="Class and section"
              value={selection.classId}
              disabled={classes.isLoading}
              change={(classId) =>
                setSelection({ ...selection, classId, examId: '', studentId: '' })
              }
            >
              <option value="">Select a class and section</option>
              {sections
                .filter((item) => !selection.grade || item.grade === selection.grade)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    Class {item.grade} · Section {item.section} · {item.academic_session_label}
                  </option>
                ))}
            </ResultFilter>
            <ResultFilter
              id="results-exam"
              label="Examination"
              value={selection.examId}
              disabled={!classroom || exams.isLoading || !!exams.error}
              change={(examId) => setSelection({ ...selection, examId, studentId: '' })}
            >
              <option value="">
                {!classroom ? 'Choose a section first' : 'Select an examination'}
              </option>
              {exams.data?.map((item) => (
                <option key={String(item.id)} value={String(item.id)}>
                  {String(item.name)} ·{' '}
                  {item.assessment_kind === 'SUBJECT_TEST'
                    ? 'Subject test'
                    : 'Official examination'}{' '}
                  · {String(item.status)}
                </option>
              ))}
            </ResultFilter>
            <div className="min-w-0">
              <label htmlFor="results-student" className="field-label">
                Student
              </label>
              <RecordSelect
                key={selection.examId}
                name="student_id"
                id="results-student"
                label="student"
                endpoint={`/results/exams/${selection.examId}/students`}
                value={selection.studentId}
                disabled={!exam}
                onChange={(studentId) => setSelection({ ...selection, studentId })}
              />
            </div>
          </section>
          {classes.isLoading || exams.isLoading ? (
            <Loading />
          ) : exams.error ? (
            <ErrorState error={exams.error} retry={() => exams.refetch()} />
          ) : !classroom ? (
            <Empty
              title="Select a class and section"
              description="Each section has its own examinations and roster."
            />
          ) : !exam ? (
            <Empty
              title={
                exams.data?.length ? 'Select an examination' : 'No examinations for this class'
              }
              description={
                canManageExams
                  ? 'Choose an examination or create one in Manage examinations.'
                  : 'Examinations appear here after the school creates them.'
              }
            />
          ) : (
            <>
              {selection.studentId && (
                <StudentResultSheet examId={selection.examId} studentId={selection.studentId} />
              )}
              <div key={`${selection.classId}:${selection.examId}`}>
                <p className="mb-4 text-sm text-stone-600">
                  {classLabel} · {String(exam.name)} · Maximum per subject {String(exam.max_score)}{' '}
                  · {String(exam.status)}
                </p>
                {canRecordMarks && exam.status !== 'OPEN' && (
                  <p className="notice mb-4">
                    This examination is read-only. Open it in Manage examinations before adding or
                    changing marks.
                  </p>
                )}
                <ResourceScreen
                  resource="marks"
                  assessment={{ classId: selection.classId, classLabel, exam }}
                />
              </div>
            </>
          )}
        </>
      )}
      {policy && (
        <Suspense fallback={<Loading />}>
          <ResultPolicyDialog close={() => setPolicy(false)} />
        </Suspense>
      )}
    </>
  );
}
