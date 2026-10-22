import { useState, lazy, Suspense } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Page } from '@vidyalayaa/contracts';
import { api, useAuth } from '../../lib/auth';
import { display } from '../../lib/utils';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { ErrorState, Loading } from '../../components/common';

const EnrollmentForm = lazy(() =>
  import('../resources/ResourceScreen').then((m) => ({ default: m.ResourceForm })),
);

// Keep enrollment management beside the student's profile; Academics loads counts only.
export default function StudentEnrollments({ studentId }: { studentId: string }) {
  const a = useAuth(),
    qc = useQueryClient();
  const [page, setPage] = useState(1),
    [editing, setEditing] = useState<Record<string, unknown> | null>(),
    [dirty, setDirty] = useState(false);
  const q = useQuery({
    queryKey: [a.school, 'student-enrollments', studentId, page],
    queryFn: () => api<Page>(`/resources/enrollments?student_id=${studentId}&page=${page}`),
  });
  const close = () => {
    if (!dirty || window.confirm('Close with unsaved changes? The draft stays in this tab.')) {
      setDirty(false);
      setEditing(undefined);
    }
  };
  return (
    <section aria-label="Student enrollments" className="rounded-xl border border-stone-200 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-semibold">Class enrollments</h3>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setDirty(false);
            setEditing(null);
          }}
        >
          Add enrollment
        </Button>
      </div>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorState error={q.error} retry={() => q.refetch()} />
      ) : !q.data?.data.length ? (
        <p className="text-sm text-stone-500">No enrollment records yet.</p>
      ) : (
        <ul className="divide-y divide-stone-100">
          {q.data.data.map((r) => (
            <li
              key={String(r.id)}
              className="flex flex-wrap items-center justify-between gap-3 py-3"
            >
              <div className="text-sm">
                <p className="font-medium">
                  {String(r.class_label)} · {String(r.academic_session_label)}
                </p>
                <p>
                  {String(r.status)} · Roll {String(r.roll_number || '—')} ·{' '}
                  {display(String(r.starts_on).slice(0, 10))}
                  {r.ends_on ? ` – ${display(String(r.ends_on).slice(0, 10))}` : ''}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                aria-label={`Edit enrollment ${String(r.class_label)} ${String(r.academic_session_label)}`}
                onClick={() => {
                  setDirty(false);
                  setEditing(r);
                }}
              >
                Edit enrollment
              </Button>
            </li>
          ))}
        </ul>
      )}
      {(q.data?.total || 0) > 25 && (
        <div className="mt-3 flex items-center gap-3">
          <Button
            size="sm"
            variant="outline"
            disabled={page === 1}
            onClick={() => setPage(page - 1)}
          >
            Previous enrollments
          </Button>
          <span className="text-sm">Page {page}</span>
          <Button
            size="sm"
            variant="outline"
            disabled={page * 25 >= (q.data?.total || 0)}
            onClick={() => setPage(page + 1)}
          >
            Next enrollments
          </Button>
        </div>
      )}
      {editing !== undefined && (
        <Dialog
          open
          title={editing ? 'Edit enrollment' : 'Add enrollment'}
          description="Choose the class and its matching academic session. Existing enrollment history is preserved."
          onOpenChange={(v) => {
            if (!v) close();
          }}
        >
          <Suspense fallback={<Loading />}>
            <EnrollmentForm
              resource="enrollments"
              initial={editing || undefined}
              preset={{ student_id: studentId }}
              hiddenFields={['student_id']}
              draftScope={`student:${studentId}`}
              onDirtyChange={setDirty}
              cancel={close}
              done={async () => {
                await qc.invalidateQueries({ queryKey: [a.school] });
                setDirty(false);
                setEditing(undefined);
              }}
            />
          </Suspense>
        </Dialog>
      )}
    </section>
  );
}
