import { lazy, Suspense, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  StudentAcademics as AcademicsData,
  StudentResults as ResultsData,
} from '@vidyalayaa/contracts';
import { api, useAuth } from '../../lib/auth';
import { Badge, Empty, ErrorState, Loading, PageHeading } from '../../components/common';
import { Button } from '../../components/ui/button';
import { Metric } from '../parents/ParentInsightsControls';
import SubjectMaterials, { type MaterialSubject } from '../materials/SubjectMaterials';
const ResultCharts = lazy(() => import('../parents/ResultCharts'));

export function StudentAcademics() {
  const a = useAuth();
  const [material, setMaterial] = useState<MaterialSubject>();
  const allowed =
    a.me?.school?.role === 'student' && a.me.school.permissions.includes('academics.read');
  const q = useQuery({
    queryKey: [a.school, a.me?.id, 'student-academics'],
    queryFn: () => api<AcademicsData>('/student/academics'),
    enabled: allowed,
    staleTime: 0,
  });
  if (!allowed) return <Empty title="Access unavailable" />;
  return (
    <>
      <PageHeading
        title="Academics"
        description="Your class, section, academic session and subjects, together."
      />
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorState error={q.error} retry={() => q.refetch()} />
      ) : !q.data?.classes.length ? (
        <Empty
          title="No current class enrollment"
          description="Your School Admin can check your class and academic session."
        />
      ) : (
        q.data.classes.map((c) => (
          <section
            key={c.class_id}
            aria-label={`Class ${c.grade} · Section ${c.section}`}
            className="mb-6 min-w-0 rounded-3xl border border-line bg-surface p-5 sm:p-7"
          >
            <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-xl font-semibold">
                Class {c.grade} · Section {c.section}
              </h2>
              <Badge>ACTIVE</Badge>
            </div>
            <dl className="mb-7 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              {[
                ['Academic session', c.session_name],
                ['Session dates', `${c.session_starts_on} – ${c.session_ends_on}`],
                ['Roll number', c.roll_number || 'Not recorded'],
                ['Class Teacher', c.class_teacher || 'Not assigned'],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-xs font-medium text-stone-500">{label}</dt>
                  <dd className="mt-1 break-words text-sm font-medium">{value}</dd>
                </div>
              ))}
            </dl>
            <h3 className="mb-3 text-lg font-semibold">Subjects</h3>
            <p className="mb-4 text-sm text-stone-600">
              {c.subjects.length} {c.subjects.length === 1 ? 'subject' : 'subjects'} configured for
              your class and section.
            </p>
            {c.subjects.length ? (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {c.subjects.map((s) => (
                  <button
                    type="button"
                    key={s.id}
                    className="min-w-0 rounded-2xl border border-line bg-stone-50 p-4 text-left transition-colors hover:border-lime-500 hover:bg-lime-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
                    onClick={() =>
                      setMaterial({
                        classId: c.class_id,
                        subjectId: s.id,
                        name: s.name,
                        classLabel: `Class ${c.grade} · Section ${c.section}`,
                      })
                    }
                  >
                    <h4 className="break-words font-semibold">{s.name}</h4>
                    <p className="mt-1 break-words text-xs text-stone-500">
                      Subject code · {s.code}
                    </p>
                    <p className="mt-3 break-words text-sm">
                      Teacher · {s.teachers.join(', ') || 'Not assigned'}
                    </p>
                    <p className="mt-3 text-xs font-semibold text-stone-700">
                      View study materials →
                    </p>
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-sm text-stone-600">
                No current subjects configured. Ask your School Admin to check your class subjects.
              </p>
            )}
          </section>
        ))
      )}
      {material && (
        <SubjectMaterials
          key={material.classId + material.subjectId}
          subject={material}
          close={() => setMaterial(undefined)}
        />
      )}
    </>
  );
}

export function StudentResults() {
  const a = useAuth(),
    [exam, setExam] = useState(''),
    [subject, setSubject] = useState(''),
    [page, setPage] = useState(1);
  const allowed =
    a.me?.school?.role === 'student' && a.me.school.permissions.includes('marks.read');
  const params = new URLSearchParams({
    page: String(page),
    ...(exam ? { exam_id: exam } : {}),
    ...(subject ? { subject_id: subject } : {}),
  });
  const q = useQuery({
    queryKey: [a.school, a.me?.id, 'student-results', params.toString()],
    queryFn: () => api<ResultsData>(`/student/results?${params}`),
    enabled: allowed,
    staleTime: 0,
  });
  if (!allowed) return <Empty title="Access unavailable" />;
  return (
    <>
      <PageHeading
        title="My results"
        description="Your published examination marks and subject performance."
        actions={
          <Button variant="outline" onClick={() => q.refetch()} disabled={q.isFetching}>
            Refresh results
          </Button>
        }
      />
      <p className="mb-5 rounded-2xl border border-line bg-surface p-4 text-sm text-stone-600">
        Only published examinations are visible. Marks saved for an open or locked examination
        appear after your school publishes it.
      </p>
      <div className="mb-5 grid gap-4 rounded-2xl border border-line bg-surface p-5 sm:grid-cols-2">
        <label className="text-sm">
          Examination
          <select
            aria-label="Result examination"
            className="input mt-2"
            value={exam}
            onChange={(e) => {
              setExam(e.target.value);
              setPage(1);
            }}
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
            aria-label="Result subject"
            className="input mt-2"
            value={subject}
            onChange={(e) => {
              setSubject(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All subjects</option>
            {q.data?.subjects.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorState error={q.error} retry={() => q.refetch()} />
      ) : !q.data?.total ? (
        <Empty
          title="No published results in this selection"
          description="If your teacher has entered marks, your School Admin must publish the examination before they appear here. You can also change the filters."
        />
      ) : (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Metric
              title="Overall result"
              value={q.data.summary.percentage === null ? '—' : q.data.summary.percentage + '%'}
              detail="Recorded marks ÷ examination maxima"
            />
            <Metric
              title="Published examinations"
              value={q.data.summary.examinations}
              detail="In your current selection"
            />
            <Metric
              title="Subjects"
              value={q.data.subject_chart.length}
              detail="With published, recorded marks"
            />
            <Metric
              title="Marks earned"
              value={`${q.data.summary.score} / ${q.data.summary.maximum}`}
              detail="Missing marks are not counted as zero"
            />
          </div>
          <Suspense fallback={<Loading />}>
            <ResultCharts data={q.data} />
          </Suspense>
          <div className="mt-5 overflow-x-auto rounded-2xl border border-line bg-surface">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">My published marks</caption>
              <thead>
                <tr>
                  {[
                    'Examination',
                    'Class & section',
                    'Academic session',
                    'Date',
                    'Subject',
                    'Marks',
                    'Result',
                    'Remarks',
                  ].map((h) => (
                    <th scope="col" className="whitespace-nowrap p-4 font-medium" key={h}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {q.data.data.map((r) => (
                  <tr className="border-t border-line" key={r.id}>
                    <td className="p-4">{r.examination}</td>
                    <td className="whitespace-nowrap p-4">
                      Class {r.grade} · Section {r.section}
                    </td>
                    <td className="p-4">{r.session_name}</td>
                    <td className="whitespace-nowrap p-4">
                      {r.exam_date || r.result_date + ' (record date)'}
                    </td>
                    <td className="p-4">{r.subject}</td>
                    <td className="whitespace-nowrap p-4">
                      {r.score} / {r.max_score}
                    </td>
                    <td className="p-4">{Math.round((r.score / r.max_score) * 1000) / 10}%</td>
                    <td className="p-4">{r.remarks || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
            <p className="mr-auto">
              {q.data.total} {q.data.total === 1 ? 'mark' : 'marks'} · Page {page}
            </p>
            <Button
              variant="outline"
              disabled={page === 1 || q.isFetching}
              onClick={() => setPage(page - 1)}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              disabled={page * q.data.page_size >= q.data.total || q.isFetching}
              onClick={() => setPage(page + 1)}
            >
              Next
            </Button>
          </div>
        </>
      )}
    </>
  );
}
