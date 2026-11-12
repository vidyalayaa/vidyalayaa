import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Plus, BookOpen } from 'lucide-react';
import { api, downloadReport, useAuth } from '../../lib/auth';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { PageHeading, Loading, ErrorState, Empty } from '../../components/common';
import { ResourceForm } from '../resources/ResourceScreen';
import { schoolToday, shiftDate, prettyDate } from '../calendar/calendar-utils';
import type {
  HomeworkDiaryEntry as Homework,
  HomeworkDiaryResponse as Diary,
} from '@vidyalayaa/contracts';
export default function HomeworkDiary({ basePath = '/homework' }: { basePath?: string }) {
  const a = useAuth(),
    qc = useQueryClient(),
    today = schoolToday(a.me?.school?.timezone);
  const [day, setDay] = useState(today),
    [classId, setClass] = useState(''),
    [page, setPage] = useState(1),
    [editing, setEditing] = useState<Homework | null | undefined>(),
    [error, setError] = useState(''),
    [removing, setRemoving] = useState<Homework>(),
    [busy, setBusy] = useState(false);
  const canWrite =
    ['school_admin', 'teacher'].includes(a.me?.school?.role || '') &&
    !!a.me?.school?.permissions.includes('assignments.write');
  const params = new URLSearchParams({
    date: day,
    kind: 'HOMEWORK',
    page: String(page),
    ...(classId ? { class_id: classId } : {}),
  });
  const q = useQuery({
    queryKey: [a.school, 'homework-diary', basePath, params.toString()],
    queryFn: () => api<Diary>(`${basePath}/diary?${params}`),
    refetchInterval: 30000,
  });
  const select = (value: string) => {
    setDay(value);
    setPage(1);
  };
  const monthStart = day.slice(0, 7) + '-01',
    offset = (new Date(monthStart + 'T12:00:00Z').getUTCDay() + 6) % 7;
  const days = new Date(Number(day.slice(0, 4)), Number(day.slice(5, 7)), 0).getDate();
  const groups = new Map<string, Homework[]>();
  for (const row of q.data?.data || []) {
    const subject = row.subject || 'General homework';
    groups.set(subject, [...(groups.get(subject) || []), row]);
  }
  const refresh = async () => {
    setEditing(undefined);
    await qc.invalidateQueries({ queryKey: [a.school] });
  };
  return (
    <>
      <PageHeading
        title="Homework diary"
        description="One day at a time. Every subject in its place."
        actions={
          canWrite ? (
            <Button variant="lime" onClick={() => setEditing(null)}>
              <Plus size={16} />
              Add homework
            </Button>
          ) : undefined
        }
      />
      <div className="mb-6 flex flex-wrap items-end gap-3 rounded-2xl border border-line bg-surface p-5">
        <Button
          variant="outline"
          aria-label="Previous date"
          onClick={() => select(shiftDate(day, -1))}
        >
          <ChevronLeft size={18} />
        </Button>
        <label className="text-sm">
          Diary date
          <input
            aria-label="Diary date"
            className="input mt-2"
            type="date"
            required
            value={day}
            onChange={(e) => e.target.value && select(e.target.value)}
          />
        </label>
        <Button variant="outline" aria-label="Next date" onClick={() => select(shiftDate(day, 1))}>
          <ChevronRight size={18} />
        </Button>
        <Button variant="outline" onClick={() => select(today)}>
          Today
        </Button>
        {!basePath.startsWith('/parent/') && (
          <label className="min-w-48 text-sm">
            Class and section
            <select
              className="input mt-2"
              aria-label="Diary class and section"
              value={classId}
              onChange={(e) => {
                setClass(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All my classes</option>
              {q.data?.classes.map((c) => (
                <option key={c.id} value={c.id}>
                  Class {c.grade} · Section {c.section}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {error && (
        <p role="alert" className="field-error mb-4">
          {error}
        </p>
      )}
      <div className="grid items-start gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
        <aside
          className="rounded-2xl border border-line bg-surface p-5"
          aria-label="Homework calendar"
        >
          <div className="mb-4 flex items-center justify-between">
            <Button
              size="sm"
              variant="ghost"
              aria-label="Previous month"
              onClick={() => select(shiftDate(monthStart, -1))}
            >
              <ChevronLeft size={16} />
            </Button>
            <span className="text-sm font-semibold">
              {new Intl.DateTimeFormat('en-IN', {
                month: 'long',
                year: 'numeric',
                timeZone: 'UTC',
              }).format(new Date(day + 'T12:00:00Z'))}
            </span>
            <Button
              size="sm"
              variant="ghost"
              aria-label="Next month"
              onClick={() => select(shiftDate(monthStart, days))}
            >
              <ChevronRight size={16} />
            </Button>
          </div>
          <div className="grid grid-cols-7 gap-1 text-center">
            {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
              <span key={i} className="py-2 text-xs text-stone-500">
                {d}
              </span>
            ))}
            {Array.from({ length: offset }, (_, i) => (
              <span key={'blank' + i} />
            ))}
            {Array.from({ length: days }, (_, i) => {
              const date = day.slice(0, 7) + '-' + String(i + 1).padStart(2, '0'),
                count = q.data?.dates.find((d) => d.date === date)?.count || 0;
              return (
                <button
                  key={date}
                  type="button"
                  aria-label={`${date}, ${count} homework`}
                  aria-pressed={day === date}
                  onClick={() => select(date)}
                  className={`relative min-h-10 rounded-lg text-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus ${day === date ? 'bg-action text-on-action' : count ? 'bg-lime-100 text-ink' : 'hover:bg-stone-100'} ${date === today ? 'ring-1 ring-focus' : ''}`}
                >
                  {i + 1}
                  {count > 0 && (
                    <span className="absolute bottom-1 left-1/2 size-1 -translate-x-1/2 rounded-full bg-lime-600" />
                  )}
                </button>
              );
            })}
          </div>
          <p className="mt-4 text-xs leading-5 text-stone-500">
            Highlighted dates contain homework in your selected class. Dates follow your school’s
            timezone.
          </p>
        </aside>
        <section className="min-w-0" aria-label="Daily homework">
          <h2 className="mb-5 text-xl font-semibold">
            {day === today ? 'Today · ' : ''}
            {prettyDate(day)}
          </h2>
          {q.isLoading ? (
            <Loading />
          ) : q.error ? (
            <ErrorState error={q.error} retry={() => q.refetch()} />
          ) : !q.data?.total ? (
            <Empty
              title="No homework for this date"
              description="Choose another date to browse your diary."
            />
          ) : (
            <>
              {[...groups].map(([subject, rows]) => (
                <section key={subject} className="mb-6">
                  <h3 className="mb-3 flex items-center gap-2 text-lg font-semibold">
                    <BookOpen size={19} />
                    {subject}
                  </h3>
                  <div className="space-y-4">
                    {rows.map((row) => (
                      <article
                        key={row.id}
                        className="rounded-2xl border border-line bg-surface p-5 sm:p-6"
                      >
                        <div className="flex flex-wrap justify-between gap-3">
                          <div>
                            <p className="mb-2 text-xs text-stone-500">
                              Class {row.grade} · Section {row.section}
                            </p>
                            <h4 className="break-words text-lg font-semibold">{row.title}</h4>
                          </div>
                          {canWrite && (
                            <div className="flex gap-2">
                              <Button size="sm" variant="outline" onClick={() => setEditing(row)}>
                                Edit
                              </Button>
                              <Button size="sm" variant="outline" onClick={() => setRemoving(row)}>
                                Delete
                              </Button>
                            </div>
                          )}
                        </div>
                        {row.body && (
                          <p className="mt-4 whitespace-pre-wrap break-words text-sm leading-7">
                            {row.body}
                          </p>
                        )}
                        {row.instructions && (
                          <div className="mt-4 rounded-xl bg-stone-50 p-4 text-sm">
                            <h5 className="font-semibold">Instructions</h5>
                            <p className="mt-2 whitespace-pre-wrap break-words leading-6">
                              {row.instructions}
                            </p>
                          </div>
                        )}
                        <p className="mt-4 text-xs text-stone-600">
                          Assigned {row.assigned_on} ·{' '}
                          {row.due_at
                            ? `Submit by ${new Date(row.due_at).toLocaleString('en-IN', { timeZone: a.me?.school?.timezone })}`
                            : 'No submission deadline'}
                        </p>
                        <div className="mt-4 flex flex-wrap gap-3">
                          {row.storage_path && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={async () => {
                                try {
                                  const ticket = await api<{ url: string }>(
                                    `/materials/${row.id}/download`,
                                  );
                                  await downloadReport(ticket.url);
                                } catch (e) {
                                  setError((e as Error).message);
                                }
                              }}
                            >
                              Download attachment
                            </Button>
                          )}
                          {row.reference_url && /^https:\/\//.test(row.reference_url) && (
                            <Button asChild size="sm" variant="outline">
                              <a href={row.reference_url} target="_blank" rel="noopener noreferrer">
                                Reference material ↗
                              </a>
                            </Button>
                          )}
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              ))}
              <div className="flex items-center justify-between gap-3 text-sm">
                <span>
                  {q.data.total} homework · Page {page}
                </span>
                <div className="flex gap-2">
                  <Button variant="outline" disabled={page === 1} onClick={() => setPage(page - 1)}>
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    disabled={page * 50 >= q.data.total}
                    onClick={() => setPage(page + 1)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            </>
          )}
        </section>
      </div>
      <Dialog
        open={editing !== undefined}
        onOpenChange={(open) => {
          if (!open) setEditing(undefined);
        }}
        title={editing ? 'Edit homework' : 'Add homework'}
      >
        {editing !== undefined && (
          <ResourceForm
            key={editing?.id || day}
            resource="assignments"
            initial={editing || undefined}
            preset={{
              kind: 'HOMEWORK',
              ...(!editing ? { assigned_on: day, ...(classId ? { class_id: classId } : {}) } : {}),
            }}
            hiddenFields={['kind']}
            draftScope={`diary:${day}:HOMEWORK`}
            done={refresh}
            cancel={() => setEditing(undefined)}
          />
        )}
      </Dialog>
      <Dialog
        open={!!removing}
        onOpenChange={(open) => {
          if (!open && !busy) setRemoving(undefined);
        }}
        title="Delete homework"
        description="This removes the assignment from diaries and preserves its record for audit."
      >
        <p className="mb-5 text-sm">Delete “{removing?.title}”?</p>
        <Button
          variant="lime"
          disabled={busy}
          onClick={async () => {
            if (!removing) return;
            setBusy(true);
            try {
              await api(`/homework/${removing.id}`, { method: 'DELETE' });
              setRemoving(undefined);
              await refresh();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Deleting…' : 'Delete homework'}
        </Button>
      </Dialog>
    </>
  );
}
