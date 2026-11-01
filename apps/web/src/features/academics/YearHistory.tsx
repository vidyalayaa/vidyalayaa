import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { PromotionWorkspace, PromotionYear } from '@vidyalayaa/contracts';
import { api, useAuth } from '../../lib/auth';
import { display, label } from '../../lib/utils';
import { Button } from '../../components/ui/button';
import { Loading, ErrorState, Empty } from '../../components/common';
const sections = [
  ['students', 'Students'],
  ['attendance', 'Attendance'],
  ['results', 'Results'],
  ['homework', 'Homework & materials'],
  ['subjects', 'Teachers & subjects'],
  ['timetable', 'Timetable'],
  ['fees', 'Fees'],
  ['payments', 'Receipts'],
] as const;
export default function YearHistory({ workspace }: { workspace: PromotionWorkspace }) {
  const a = useAuth(),
    [year, setYear] = useState(
      workspace.years.find((y) => y.is_current)?.id || workspace.years[0]?.id || '',
    ),
    [section, setSection] = useState('students'),
    [classId, setClass] = useState(''),
    [page, setPage] = useState(1);
  const params = new URLSearchParams({
    section,
    page: String(page),
    ...(classId ? { class_id: classId } : {}),
  });
  const q = useQuery({
    queryKey: [a.school, 'academic-year-history', year, params.toString()],
    queryFn: () =>
      api<{
        session: PromotionYear;
        data: Record<string, unknown>[];
        columns: string[];
        total: number;
        page_size: number;
      }>(`/promotion/history/${year}?${params}`),
    enabled: !!year,
  });
  return (
    <section aria-label="Academic-year records" className="space-y-5">
      <div className="rounded-2xl border border-line bg-white p-5">
        <h2 className="text-xl font-semibold">View another academic year</h2>
        <p className="mt-2 text-sm leading-6 text-stone-600">
          Browse saved records without changing the active year, students or fees. This view is
          always read-only.
        </p>
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <label className="text-sm">
            Academic year
            <select
              className="input mt-2"
              aria-label="History academic year"
              value={year}
              onChange={(e) => {
                setYear(e.target.value);
                setClass('');
                setPage(1);
              }}
            >
              {workspace.years.map((y) => (
                <option key={y.id} value={y.id}>
                  {y.name}
                  {y.closed_at ? ' · Closed' : y.is_current ? ' · Current' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            Class and section
            <select
              className="input mt-2"
              aria-label="History class and section"
              value={classId}
              onChange={(e) => {
                setClass(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All classes</option>
              {workspace.classes
                .filter((c) => c.academic_session_id === year)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    Class {c.grade} · Section {c.section}
                  </option>
                ))}
            </select>
          </label>
        </div>
      </div>
      <div className="flex flex-wrap gap-2" aria-label="Year record categories">
        {sections.map(([key, name]) => (
          <Button
            key={key}
            variant={section === key ? 'lime' : 'outline'}
            onClick={() => {
              setSection(key);
              setPage(1);
            }}
          >
            {name}
          </Button>
        ))}
      </div>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorState error={q.error} retry={() => q.refetch()} />
      ) : (
        q.data && (
          <>
            <p className="text-sm text-stone-600">
              {q.data.session.name} · {q.data.session.starts_on} – {q.data.session.ends_on} ·{' '}
              {q.data.total} records
            </p>
            {!q.data.data.length ? (
              <Empty title="No records in this selection" />
            ) : (
              <div className="overflow-x-auto rounded-2xl border border-line bg-white">
                <table className="w-full text-left text-sm">
                  <caption className="sr-only">
                    {q.data.session.name} {section} records
                  </caption>
                  <thead>
                    <tr>
                      {q.data.columns.map((c) => (
                        <th key={c} scope="col" className="whitespace-nowrap p-4 font-medium">
                          {label(c)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {q.data.data.map((row) => (
                      <tr key={String(row.id)} className="border-t border-line">
                        {q.data!.columns.map((c) => (
                          <td key={c} className="max-w-md break-words p-4 align-top">
                            {display(row[c], a.me?.school?.timezone)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="flex items-center justify-between gap-3 text-sm">
              <span>Page {page}</span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  disabled={page === 1 || q.isFetching}
                  onClick={() => setPage(page - 1)}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  disabled={page * 50 >= q.data.total || q.isFetching}
                  onClick={() => setPage(page + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        )
      )}
    </section>
  );
}
