import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, ChevronDown, GraduationCap, Plus, Search, Users } from 'lucide-react';
import type {
  AcademicClass,
  AcademicSubject,
  AcademicSession,
  Page,
  Resource,
} from '@vidyalayaa/contracts';
import { api, useAuth } from '../../lib/auth';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Badge, DataTable, Empty, ErrorState, Loading, PageHeading } from '../../components/common';
import { ActionDialog } from '../../components/ActionDialog';
import { ResourceForm } from '../resources/ResourceScreen';
import ClassSubjectForm from './ClassSubjectForm';
import SubjectMaterials, { type MaterialSubject } from '../materials/SubjectMaterials';

interface ClassPage extends Page<AcademicClass> {
  sessions: AcademicSession[];
}
type Edit = {
  resource: Resource;
  title: string;
  description?: string;
  initial?: Record<string, unknown>;
  preset?: Record<string, unknown>;
  hidden?: string[];
  scope?: string;
};
type Archive = { resource: Resource; id: string; title: string };
const compare = new Intl.Collator('en', { numeric: true, sensitivity: 'base' }).compare;

async function allClasses(signal: AbortSignal) {
  const rows = new Map<string, AcademicClass>();
  let sessions: AcademicSession[] = [];
  for (let page = 1; ; page++) {
    const result = await api<ClassPage>(`/academics/classes?page_size=100&page=${page}`, {
      signal,
    });
    for (const c of result.data) rows.set(c.id, c);
    sessions = result.sessions;
    if (page * result.page_size >= result.total || !result.data.length)
      return { classes: [...rows.values()], sessions };
  }
}

function Paging({
  page,
  total,
  onPage,
  caption,
}: {
  page: number;
  total: number;
  onPage: (page: number) => void;
  caption: string;
}) {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
      <Button
        size="sm"
        variant="outline"
        disabled={page === 1}
        onClick={() => onPage(page - 1)}
        aria-label={`Previous ${caption}`}
      >
        Previous
      </Button>
      <span>
        Page {page} · {total} {caption}
      </span>
      <Button
        size="sm"
        variant="outline"
        disabled={page * 25 >= total}
        onClick={() => onPage(page + 1)}
        aria-label={`Next ${caption}`}
      >
        Next
      </Button>
    </div>
  );
}

export default function Academics() {
  const a = useAuth(),
    qc = useQueryClient();
  const [search, setSearch] = useState(''),
    [session, setSession] = useState(''),
    [edit, setEdit] = useState<Edit>(),
    [subjectClass, setSubjectClass] = useState<AcademicClass>(),
    [archive, setArchive] = useState<Archive>(),
    [sessionsOpen, setSessionsOpen] = useState(false),
    [dirty, setDirty] = useState(false);
  const q = useQuery({
    queryKey: [a.school, 'academic-classes'],
    queryFn: ({ signal }) => allClasses(signal),
    enabled: a.me?.school?.role === 'school_admin',
  });
  const can = (permission: string) => !!a.me?.school?.permissions.includes(permission);
  function open(next: Edit) {
    setDirty(false);
    setEdit(next);
  }
  function close() {
    if (!dirty || window.confirm('Close with unsaved changes? The draft stays in this tab.')) {
      setDirty(false);
      setEdit(undefined);
    }
  }
  const groups = new Map<string, AcademicClass[]>();
  for (const c of q.data?.classes || []) {
    if (session && c.academic_session_id !== session) continue;
    if (
      search &&
      !`class ${c.grade} section ${c.section} ${c.class_teacher_label || ''}`
        .toLowerCase()
        .includes(search.toLowerCase().trim())
    )
      continue;
    const key = `${c.academic_session_id}:${c.grade}`;
    groups.set(key, [...(groups.get(key) || []), c]);
  }
  const ordered = [...groups.values()].sort(
    (x, y) =>
      compare(x[0].grade, y[0].grade) ||
      compare(x[0].academic_session_label, y[0].academic_session_label),
  );
  if (a.me?.school?.role !== 'school_admin')
    return (
      <Empty
        title="Access unavailable"
        description="Class-wise academic management belongs to School Admin."
      />
    );
  return (
    <>
      <PageHeading
        title="Every class. Everything together."
        description="Classes, sections, subjects, student counts and teachers, in one place."
        actions={
          <>
            <Button asChild variant="outline">
              <Link to="/admin/academic-years">Academic-year promotion</Link>
            </Button>
            <Button
              variant="outline"
              onClick={() => setSessionsOpen((v) => !v)}
              aria-expanded={sessionsOpen}
              aria-controls="academic-sessions"
            >
              Academic sessions
            </Button>
            {can('academics.write') && (
              <Button
                variant="lime"
                onClick={() =>
                  open({ resource: 'classes', title: 'Add class & section', scope: 'new-class' })
                }
              >
                <Plus size={16} /> Add class & section
              </Button>
            )}
          </>
        }
      />
      {sessionsOpen && (
        <section
          id="academic-sessions"
          aria-label="Academic sessions"
          className="mb-6 rounded-2xl border border-stone-200 bg-white p-5"
        >
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">Academic sessions</h2>
            {can('academics.write') && (
              <Button
                size="sm"
                variant="lime"
                onClick={() =>
                  open({ resource: 'academic_sessions', title: 'Add academic session' })
                }
              >
                <Plus size={15} /> Add academic session
              </Button>
            )}
          </div>
          {q.isLoading ? (
            <Loading />
          ) : q.error ? (
            <ErrorState error={q.error} retry={() => q.refetch()} />
          ) : !q.data?.sessions.length ? (
            <p className="text-sm text-stone-500">
              Add an academic session before creating classes.
            </p>
          ) : (
            <ul className="divide-y divide-stone-100">
              {q.data.sessions.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div>
                    <h3 className="font-medium">
                      {s.name}
                      {s.is_current ? ' · Current' : ''}
                      {s.closed_at ? ' · Closed · Read-only' : ''}
                    </h3>
                    <p className="text-sm text-stone-500">
                      {s.starts_on.slice(0, 10)} – {s.ends_on.slice(0, 10)}
                    </p>
                  </div>
                  {can('academics.write') && !s.closed_at && (
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`Edit session ${s.name}`}
                        onClick={() =>
                          open({
                            resource: 'academic_sessions',
                            title: 'Edit academic session',
                            initial: s,
                          })
                        }
                      >
                        Edit session
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Archive session ${s.name}`}
                        onClick={() =>
                          setArchive({
                            resource: 'academic_sessions',
                            id: s.id,
                            title: 'Archive academic session',
                          })
                        }
                      >
                        Archive session
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <div className="mb-6 flex flex-wrap gap-4 rounded-2xl border border-stone-200 bg-white p-4">
        <label className="min-w-0 flex-1 text-sm">
          Find a class, section or Class Teacher
          <div className="search-input mt-2">
            <Search size={16} />
            <input
              aria-label="Find academic class"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Try Class 8 or Section A"
            />
          </div>
        </label>
        <label className="text-sm">
          Academic session
          <select
            className="input mt-2"
            aria-label="Academic session"
            value={session}
            onChange={(e) => setSession(e.target.value)}
          >
            <option value="">All academic sessions</option>
            {q.data?.sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.is_current ? ' · Current' : ''}
              </option>
            ))}
          </select>
        </label>
      </div>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorState error={q.error} retry={() => q.refetch()} />
      ) : !ordered.length ? (
        <Empty
          title="No classes to display"
          description={
            q.data?.classes.length
              ? 'Adjust the search or session filter.'
              : 'Add the first class and section to start organising your academics.'
          }
        />
      ) : (
        <div className="space-y-7">
          {ordered.map((sections) => {
            const first = sections[0];
            return (
              <section
                key={`${first.academic_session_id}:${first.grade}`}
                aria-label={`Class ${first.grade} · ${first.academic_session_label}`}
                className="rounded-2xl border border-stone-200 bg-white"
              >
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-100 p-5">
                  <div className="flex items-center gap-3">
                    <span className="rounded-xl bg-lime-100 p-3 text-stone-800">
                      <GraduationCap size={22} />
                    </span>
                    <div>
                      <h2 className="text-xl font-semibold">Class {first.grade}</h2>
                      <p className="text-sm text-stone-500">
                        {first.academic_session_label} · {sections.length}{' '}
                        {sections.length === 1 ? 'section' : 'sections'} ·{' '}
                        {sections.reduce((n, c) => n + c.student_count, 0)} students
                        {' · '}
                        {sections.reduce((n, c) => n + c.male_count, 0)} male
                        {' · '}
                        {sections.reduce((n, c) => n + c.female_count, 0)} female
                      </p>
                    </div>
                  </div>
                  {can('academics.write') &&
                    !q.data?.sessions.find((s) => s.id === first.academic_session_id)
                      ?.closed_at && (
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`Add section to Class ${first.grade} · ${first.academic_session_label}`}
                        onClick={() =>
                          open({
                            resource: 'classes',
                            title: `Add section to Class ${first.grade}`,
                            preset: {
                              grade: first.grade,
                              academic_session_id: first.academic_session_id,
                            },
                            hidden: ['grade', 'academic_session_id'],
                            scope: `new-section:${first.academic_session_id}:${first.grade}`,
                          })
                        }
                      >
                        <Plus size={15} /> Add section
                      </Button>
                    )}
                </div>
                <div className="divide-y divide-stone-100">
                  {[...sections]
                    .sort((x, y) => compare(x.section, y.section))
                    .map((c) => (
                      <ClassSection
                        key={c.id}
                        c={c}
                        can={(permission) =>
                          can(permission) &&
                          !(
                            permission.endsWith('.write') &&
                            q.data?.sessions.find((s) => s.id === c.academic_session_id)?.closed_at
                          )
                        }
                        open={open}
                        archive={setArchive}
                        addSubject={setSubjectClass}
                      />
                    ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
      {edit && (
        <Dialog
          open
          title={edit.title}
          description={edit.description}
          onOpenChange={(v) => {
            if (!v) close();
          }}
        >
          <ResourceForm
            key={`${edit.resource}:${edit.initial?.id || edit.scope || 'new'}`}
            resource={edit.resource}
            initial={edit.initial}
            preset={edit.preset}
            hiddenFields={edit.hidden}
            draftScope={edit.scope}
            onDirtyChange={setDirty}
            cancel={close}
            done={async () => {
              await qc.invalidateQueries({ queryKey: [a.school] });
              setDirty(false);
              setEdit(undefined);
            }}
          />
        </Dialog>
      )}
      {subjectClass && (
        <ClassSubjectForm c={subjectClass} close={() => setSubjectClass(undefined)} />
      )}
      {archive && (
        <ActionDialog
          open
          title={archive.title}
          endpoint={`/resources/${archive.resource}/${archive.id}/retire`}
          fields={[{ key: 'reason', type: 'textarea' }]}
          close={() => setArchive(undefined)}
        />
      )}
    </>
  );
}

function LegacyAssignments({
  classId,
  canWrite,
  edit,
  archive,
}: {
  classId: string;
  canWrite: boolean;
  edit: (r: Record<string, unknown>) => void;
  archive: (a: Archive) => void;
}) {
  const a = useAuth(),
    [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: [a.school, 'academic-legacy-assignments', classId, page],
    queryFn: () => api<Page>(`/academics/classes/${classId}/unconfigured-assignments?page=${page}`),
  });
  return (
    <section
      className="rounded-xl border border-amber-200 bg-amber-50 p-4"
      aria-label="Assignments needing a subject"
    >
      <h3 className="font-semibold">Assignments needing a subject</h3>
      <p className="my-2 text-sm">
        These existing assignments have no subject. Choose a subject or archive the assignment; no
        historical record is deleted.
      </p>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorState error={q.error} retry={() => q.refetch()} />
      ) : (
        <>
          <DataTable
            rows={q.data?.data || []}
            columns={['teacher_id', 'starts_on', 'ends_on']}
            actions={
              canWrite
                ? (r) => (
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" onClick={() => edit(r)}>
                        Choose subject
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          archive({
                            resource: 'teacher_class_assignments',
                            id: String(r.id),
                            title: 'Archive legacy teacher assignment',
                          })
                        }
                      >
                        Archive assignment
                      </Button>
                    </div>
                  )
                : undefined
            }
          />
          <Paging
            page={page}
            total={q.data?.total || 0}
            onPage={setPage}
            caption="legacy assignments"
          />
        </>
      )}
    </section>
  );
}

function ClassSection({
  c,
  can,
  open,
  archive,
  addSubject,
}: {
  c: AcademicClass;
  can: (p: string) => boolean;
  open: (e: Edit) => void;
  archive: (a: Archive) => void;
  addSubject: (c: AcademicClass) => void;
}) {
  const a = useAuth(),
    [expanded, setExpanded] = useState(false),
    [material, setMaterial] = useState<MaterialSubject>(),
    [subjectPage, setSubjectPage] = useState(1);
  const subjects = useQuery({
    queryKey: [a.school, 'academic-subjects', c.id, subjectPage],
    queryFn: () =>
      api<Page<AcademicSubject>>(`/academics/classes/${c.id}/subjects?page=${subjectPage}`),
    enabled: expanded,
  });
  useEffect(() => {
    if (subjects.data && subjectPage > Math.max(1, Math.ceil(subjects.data.total / 25)))
      setSubjectPage(Math.max(1, Math.ceil(subjects.data.total / 25)));
  }, [subjects.data?.total, subjectPage]);
  const classroom = `Class ${c.grade} · Section ${c.section}`;
  function assignment(subject?: AcademicSubject, initial?: Record<string, unknown>) {
    open({
      resource: 'teacher_class_assignments',
      title: initial ? 'Edit subject teacher' : 'Assign subject teacher',
      description: classroom,
      initial,
      preset: { class_id: c.id, ...(subject ? { subject_id: subject.id } : {}) },
      hidden: ['class_id', ...(subject ? ['subject_id'] : [])],
      scope: `assignment:${c.id}:${subject?.id || 'new'}`,
    });
  }
  return (
    <details className="group/section" onToggle={(e) => setExpanded(e.currentTarget.open)}>
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-3 p-5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-600">
        <span className="sr-only">
          Class {c.grade} · {c.academic_session_label} ·{' '}
        </span>
        <ChevronDown
          className="shrink-0 transition-transform group-open/section:rotate-180"
          size={18}
        />
        <div className="min-w-0 flex-1 basis-3/4 sm:basis-0">
          <h3 className="font-semibold">Section {c.section}</h3>
          <p className="mt-1 text-sm text-stone-600">
            Class Teacher: {c.class_teacher_label || 'Not designated'}
            {c.class_teacher_status === 'INACTIVE' ? ' · Inactive — review designation' : ''}
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-stone-50 px-3 py-2 text-xs">
          <Users size={14} />
          {c.student_count} students
          {' · '}
          {c.male_count} male · {c.female_count} female
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-lime-50 px-3 py-2 text-xs">
          <BookOpen size={14} />
          {c.subject_count} subjects
        </span>
      </summary>
      {expanded && (
        <div
          className="space-y-7 border-t border-stone-100 p-5"
          role="region"
          aria-label={classroom}
        >
          <div className="flex flex-wrap gap-2">
            {can('academics.write') && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    open({
                      resource: 'classes',
                      title: 'Edit class & section',
                      initial: c,
                      scope: c.id,
                    })
                  }
                >
                  Edit class & section
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    open({
                      resource: 'classes',
                      title: 'Designate Class Teacher',
                      description: classroom,
                      initial: c,
                      preset: {
                        academic_session_id: c.academic_session_id,
                        grade: c.grade,
                        section: c.section,
                      },
                      hidden: ['academic_session_id', 'grade', 'section'],
                      scope: `class-teacher:${c.id}`,
                    })
                  }
                >
                  Designate Class Teacher
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    archive({ resource: 'classes', id: c.id, title: `Archive ${classroom}` })
                  }
                >
                  Archive section
                </Button>
              </>
            )}
          </div>
          {!!c.legacy_assignment_count && (
            <LegacyAssignments
              classId={c.id}
              canWrite={can('teachers.write')}
              edit={(r) => assignment(undefined, r)}
              archive={archive}
            />
          )}
          <section aria-label={`Subjects for ${classroom}`}>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold">Subjects & teachers</h3>
                <p className="text-sm text-stone-500">
                  Subjects linked through this section's teacher assignments. Dates show when each
                  assignment applies.
                </p>
              </div>
              {can('teachers.write') && (
                <Button size="sm" variant="lime" onClick={() => addSubject(c)}>
                  <Plus size={15} /> Add subject & teacher
                </Button>
              )}
            </div>
            {subjects.isLoading ? (
              <Loading />
            ) : subjects.error ? (
              <ErrorState error={subjects.error} retry={() => subjects.refetch()} />
            ) : !subjects.data?.data.length ? (
              <Empty
                title="No subject assignments yet"
                description="Choose a catalogue subject and assign a teacher to this section."
              />
            ) : (
              <>
                <div className="grid gap-3 lg:grid-cols-2">
                  {subjects.data.data.map((sub) => (
                    <article
                      key={sub.id}
                      aria-label={`Subject ${sub.name}`}
                      className="rounded-xl border border-stone-200 p-4"
                    >
                      <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <h4 className="font-semibold">{sub.name}</h4>
                          <p className="text-xs text-stone-500">{sub.code}</p>
                        </div>
                        {can('academics.write') && (
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Edit subject ${sub.name}`}
                            onClick={() =>
                              open({
                                resource: 'subjects',
                                title: 'Edit catalogue subject',
                                description:
                                  'Subject codes and names are shared across every section using this catalogue record.',
                                initial: sub,
                                scope: `subject:${sub.id}`,
                              })
                            }
                          >
                            Edit subject
                          </Button>
                        )}
                      </div>
                      <ul className="space-y-3">
                        {sub.teachers.map((t) => (
                          <li key={t.id} className="rounded-xl bg-stone-50 p-3">
                            <div className="flex flex-wrap items-center gap-2">
                              <strong className="text-sm">{t.teacher_label}</strong>
                              {t.teacher_id === c.class_teacher_id && (
                                <span className="rounded-full bg-lime-100 px-2 py-1 text-xs">
                                  Class Teacher
                                </span>
                              )}
                              <Badge>
                                {t.is_current
                                  ? 'ACTIVE'
                                  : t.teacher_status === 'INACTIVE'
                                    ? 'INACTIVE'
                                    : 'SCHEDULED / ENDED'}
                              </Badge>
                            </div>
                            <p className="mt-1 text-xs text-stone-500">
                              {t.staff_code} · {t.starts_on.slice(0, 10)} to{' '}
                              {t.ends_on?.slice(0, 10) || 'ongoing'}
                            </p>
                            {can('teachers.write') && (
                              <div className="mt-2 flex flex-wrap gap-2">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  aria-label={`Edit ${sub.name} assignment for ${t.teacher_label}`}
                                  onClick={() => assignment(sub, t)}
                                >
                                  Edit assignment
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  aria-label={`Archive ${sub.name} assignment for ${t.teacher_label}`}
                                  onClick={() =>
                                    archive({
                                      resource: 'teacher_class_assignments',
                                      id: t.id,
                                      title: `Archive ${sub.name} teacher assignment`,
                                    })
                                  }
                                >
                                  Archive assignment
                                </Button>
                              </div>
                            )}
                          </li>
                        ))}
                      </ul>
                      <Button
                        className="mt-3"
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setMaterial({
                            classId: c.id,
                            subjectId: sub.id,
                            name: sub.name,
                            classLabel: classroom,
                          })
                        }
                      >
                        Study materials
                      </Button>
                      {can('teachers.write') && (
                        <Button
                          className="mt-3"
                          size="sm"
                          variant="outline"
                          onClick={() => assignment(sub)}
                        >
                          Assign another teacher
                        </Button>
                      )}
                    </article>
                  ))}
                </div>
                <Paging
                  page={subjectPage}
                  total={subjects.data.total}
                  onPage={setSubjectPage}
                  caption="subjects"
                />
              </>
            )}
          </section>
          <section aria-label={`Student counts for ${classroom}`}>
            <h3 className="text-lg font-semibold">Enrolled students · {c.student_count}</h3>
            <p className="mt-1 text-sm text-stone-500">
              Active students enrolled on today's school date. Manage individual students and
              enrollments from Students.
            </p>
            <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {[
                ['Total students', c.student_count],
                ['Male', c.male_count],
                ['Female', c.female_count],
                ['Other', c.other_count],
                ['Not specified', c.unspecified_count],
              ].map(([title, count]) => (
                <div key={title} className="rounded-xl bg-stone-50 p-4">
                  <dt className="text-sm text-stone-600">{title}</dt>
                  <dd className="mt-1 text-2xl font-semibold">{count}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      )}
      {material && (
        <SubjectMaterials
          key={material.classId + material.subjectId}
          subject={material}
          close={() => setMaterial(undefined)}
        />
      )}
    </details>
  );
}
