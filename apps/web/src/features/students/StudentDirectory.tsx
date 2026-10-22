import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { ChevronDown, GraduationCap, Plus, Users } from 'lucide-react';
import type { DirectoryClass, DirectoryStudent, Page } from '@vidyalayaa/contracts';
import { api, useAuth } from '../../lib/auth';
import { display, sexLabel } from '../../lib/utils';
import { Badge, Empty, ErrorState, Loading, PageHeading } from '../../components/common';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import StudentProfileDialog from '../resources/StudentProfileDialog';
import { ResourceForm } from '../resources/ResourceScreen';
import RecordImportDialog from '../resources/RecordImportDialog';
import StudentAdmissionForm from './StudentAdmissionForm';

interface ClassPage extends Page<DirectoryClass> {
  unassigned_count: number;
}
const compare = new Intl.Collator('en', { numeric: true, sensitivity: 'base' }).compare;
async function classes(search: string, signal: AbortSignal) {
  const rows = new Map<string, DirectoryClass>();
  let unassigned = 0;
  for (let page = 1; ; page++) {
    const result = await api<ClassPage>(
      `/student-directory/classes?page_size=100&page=${page}&search=${encodeURIComponent(search)}`,
      { signal },
    );
    for (const c of result.data) rows.set(c.id, c);
    unassigned = result.unassigned_count;
    if (page * result.page_size >= result.total || !result.data.length)
      return { classes: [...rows.values()], unassigned };
  }
}
export default function StudentDirectory() {
  const a = useAuth(),
    qc = useQueryClient(),
    [params] = useSearchParams();
  const [search, setSearch] = useState(params.get('search') || ''),
    [debounced, setDebounced] = useState(search),
    [session, setSession] = useState('');
  const [adding, setAdding] = useState<string | undefined>(),
    [profile, setProfile] = useState<string>(),
    [editing, setEditing] = useState<DirectoryStudent>(),
    [dirty, setDirty] = useState(false),
    [importing, setImporting] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  useEffect(() => setSearch(params.get('search') || ''), [params]);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);
  const q = useQuery({
    queryKey: [a.school, 'student-directory', debounced],
    queryFn: ({ signal }) => classes(debounced, signal),
  });
  const canWrite = ['students.write', 'parents.write'].every((p) =>
    a.me?.school?.permissions.includes(p),
  );
  const groups = new Map<string, DirectoryClass[]>();
  for (const c of q.data?.classes || []) {
    if (session && c.academic_session_id !== session) continue;
    if (debounced && !c.student_count) continue;
    const key = c.academic_session_id + ':' + c.grade;
    groups.set(key, [...(groups.get(key) || []), c]);
  }
  const sessions = [
    ...new Map(
      (q.data?.classes || []).map((c) => [c.academic_session_id, c.session_name]),
    ).entries(),
  ];
  function closeEdit() {
    if (!dirty || window.confirm('Close with unsaved changes? Your draft stays in this tab.')) {
      setEditing(undefined);
      setDirty(false);
    }
  }
  return (
    <>
      <PageHeading
        title="Students"
        description="Every learner, with their class and family connected."
        actions={
          <>
            {canWrite && (
              <>
                <Button variant="outline" onClick={() => setImporting(true)}>
                  Import CSV
                </Button>
                <Button variant="lime" onClick={() => setAdding('')}>
                  <Plus size={17} />
                  Add student
                </Button>
              </>
            )}
          </>
        }
      />
      <div className="mb-6 flex flex-wrap gap-4 rounded-2xl border border-stone-200 bg-white p-4">
        <label className="min-w-0 flex-1 basis-full text-sm sm:basis-0">
          Find a student
          <input
            className="input mt-2"
            aria-label="Search students"
            placeholder="Name, student code or email…"
            maxLength={120}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <label className="text-sm">
          Academic session
          <select
            className="input mt-2"
            value={session}
            onChange={(e) => setSession(e.target.value)}
          >
            {[['', 'All sessions'], ...sessions].map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <Button
          className="self-end"
          variant="outline"
          onClick={() => {
            setSearch('');
            setSession('');
          }}
        >
          Reset filters
        </Button>
      </div>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorState error={q.error} retry={() => q.refetch()} />
      ) : (
        <div className="space-y-5">
          {[...groups.values()]
            .sort(
              (x, y) =>
                compare(x[0].grade, y[0].grade) || compare(x[0].session_name, y[0].session_name),
            )
            .map((group) => {
              const c = group[0],
                name = `Class ${c.grade} · ${c.session_name}`;
              return (
                <details
                  key={c.academic_session_id + ':' + c.grade}
                  open={!!expanded[c.academic_session_id + ':' + c.grade]}
                  onToggle={(e) => {
                    const open = e.currentTarget.open;
                    setExpanded((old) => ({
                      ...old,
                      [c.academic_session_id + ':' + c.grade]: open,
                    }));
                  }}
                  className="group rounded-2xl border border-stone-200 bg-white"
                >
                  <summary className="flex cursor-pointer list-none items-center gap-3 rounded-2xl p-5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-600">
                    <span className="rounded-xl bg-lime-100 p-3">
                      <GraduationCap size={22} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <h2 className="text-xl font-semibold">Class {c.grade}</h2>
                      <p className="mt-1 text-sm text-stone-600">
                        {c.session_name} · {group.length}{' '}
                        {group.length === 1 ? 'section' : 'sections'} ·{' '}
                        {group.reduce((n, g) => n + g.student_count, 0)} students
                      </p>
                    </div>
                    <ChevronDown
                      className="shrink-0 transition-transform group-open:rotate-180"
                      size={19}
                    />
                  </summary>
                  {expanded[c.academic_session_id + ':' + c.grade] && (
                    <div
                      role="region"
                      aria-label={name}
                      className="space-y-6 border-t border-stone-100 p-5"
                    >
                      {group
                        .sort((x, y) => compare(x.section, y.section))
                        .map((section) => (
                          <Roster
                            key={section.id}
                            classroom={section}
                            search={debounced}
                            profile={setProfile}
                            edit={(r) => {
                              setDirty(false);
                              setEditing(r);
                            }}
                            add={canWrite ? () => setAdding(section.id) : undefined}
                          />
                        ))}
                    </div>
                  )}
                </details>
              );
            })}
          {!session && (!debounced || !!q.data?.unassigned) && (
            <details
              open={!!expanded.unassigned}
              onToggle={(e) => {
                const open = e.currentTarget.open;
                setExpanded((old) => ({ ...old, unassigned: open }));
              }}
              className="rounded-2xl border border-stone-200 bg-white"
            >
              <summary className="flex cursor-pointer list-none items-center gap-3 rounded-2xl p-5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-600">
                <Users size={22} />
                <div className="flex-1">
                  <h2 className="font-semibold">Not currently enrolled</h2>
                  <p className="mt-1 text-sm text-stone-600">
                    {q.data?.unassigned || 0} students · Includes scheduled and former enrollments
                  </p>
                </div>
                <ChevronDown size={19} />
              </summary>
              {expanded.unassigned && (
                <div className="border-t border-stone-100 p-5">
                  <Roster
                    search={debounced}
                    profile={setProfile}
                    edit={(r) => {
                      setDirty(false);
                      setEditing(r);
                    }}
                  />
                </div>
              )}
            </details>
          )}
          {!groups.size && !q.data?.unassigned && (
            <Empty
              title={debounced ? 'No students match your search' : 'No classes yet'}
              description="Class enrollments appear here. Existing students without a current enrollment remain in the group above."
            />
          )}
        </div>
      )}
      {adding !== undefined && (
        <StudentAdmissionForm
          presetClass={adding}
          close={() => setAdding(undefined)}
          done={setProfile}
        />
      )}
      {profile && <StudentProfileDialog studentId={profile} close={() => setProfile(undefined)} />}
      {editing && (
        <Dialog
          open
          title="Edit student details"
          onOpenChange={(v) => {
            if (!v) closeEdit();
          }}
        >
          <ResourceForm
            resource="students"
            initial={editing}
            onDirtyChange={setDirty}
            cancel={closeEdit}
            done={async () => {
              await qc.invalidateQueries({ queryKey: [a.school] });
              setDirty(false);
              setEditing(undefined);
            }}
          />
        </Dialog>
      )}
      {importing && <RecordImportDialog resource="students" close={() => setImporting(false)} />}
    </>
  );
}
function Roster({
  classroom,
  search,
  profile,
  edit,
  add,
}: {
  classroom?: DirectoryClass;
  search: string;
  profile: (id: string) => void;
  edit: (row: DirectoryStudent) => void;
  add?: () => void;
}) {
  const a = useAuth(),
    [page, setPage] = useState(1);
  useEffect(() => setPage(1), [search]);
  const q = useQuery({
    queryKey: [a.school, 'directory-roster', classroom?.id || 'unassigned', search, page],
    queryFn: () =>
      api<Page<DirectoryStudent>>(
        `/student-directory/students?${classroom ? 'class_id=' + classroom.id : 'unassigned=1'}&search=${encodeURIComponent(search)}&page=${page}`,
      ),
  });
  useEffect(() => {
    if (q.data && page > Math.max(1, Math.ceil(q.data.total / 25)))
      setPage(Math.max(1, Math.ceil(q.data.total / 25)));
  }, [q.data?.total, page]);
  return (
    <section
      aria-label={
        classroom
          ? `Students in Class ${classroom.grade} Section ${classroom.section}`
          : 'Students without current enrollment'
      }
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">
          {classroom ? 'Section ' + classroom.section : 'Student records'} ·{' '}
          {q.data?.total ?? classroom?.student_count ?? 0} students
        </h3>
        {add && (
          <Button variant="outline" size="sm" onClick={add}>
            Add student to this section
          </Button>
        )}
      </div>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorState error={q.error} retry={() => q.refetch()} />
      ) : !q.data?.data.length ? (
        <p className="py-4 text-sm text-stone-500">No students in this group.</p>
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {q.data.data.map((s) => (
              <article
                key={s.id}
                className="min-w-0 rounded-xl border border-stone-200 bg-stone-50"
                aria-label={`Student ${s.student_code}`}
              >
                <button
                  className="block w-full rounded-xl p-4 text-left transition-colors hover:bg-lime-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-600"
                  onClick={() => profile(s.id)}
                >
                  <span className="block font-semibold">
                    {s.first_name} {s.last_name}
                  </span>
                  <span className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                    <span>{s.student_code}</span>
                    <Badge>{s.status}</Badge>
                  </span>
                  <span className="mt-3 block space-y-1 break-words text-sm text-stone-600">
                    <span className="block">
                      <span className="font-medium">Roll no.: </span>
                      {s.roll_number || 'Not assigned'}
                    </span>
                    <span className="block">
                      <span className="font-medium">Email: </span>
                      {s.email || 'Not specified'}
                    </span>
                    <span className="block">
                      <span className="font-medium">Birth date: </span>
                      {s.date_of_birth ? display(s.date_of_birth.slice(0, 10)) : 'Not specified'}
                      {' · Sex: '}
                      {sexLabel(s.sex)}
                    </span>
                  </span>
                  <span className="mt-4 inline-block text-sm font-medium underline underline-offset-4">
                    Full profile
                  </span>
                </button>
                <div className="px-4 pb-4">
                  {a.me?.school?.permissions.includes('students.write') && (
                    <Button size="sm" variant="ghost" onClick={() => edit(s)}>
                      Edit student
                    </Button>
                  )}
                </div>
              </article>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
            <Button
              size="sm"
              variant="outline"
              disabled={page === 1}
              onClick={() => setPage(page - 1)}
            >
              Previous students
            </Button>
            <span>
              Page {page} · {q.data.total} students
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={page * 25 >= q.data.total}
              onClick={() => setPage(page + 1)}
            >
              Next students
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
