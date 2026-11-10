import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Page as Rows, TeachingClass } from '@vidyalayaa/contracts';
import { useTeachingClasses } from '../../lib/use-teaching-classes';
import { api, useAuth } from '../../lib/auth';
import {
  PageHeading,
  Panel,
  DataTable,
  Loading,
  ErrorState,
  Empty,
  Badge,
} from '../../components/common';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { ResourceForm } from '../resources/ResourceScreen';
import BulkMarksDialog from '../resources/BulkMarksDialog';
import RollMarksDialog from '../resources/RollMarksDialog';
import StudentProfileDialog from '../resources/StudentProfileDialog';
import { PersonAvatar } from '../profiles/PersonAvatar';

function ClassChoice({
  classes,
  value,
  onChange,
}: {
  classes: TeachingClass[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <label className="block max-w-sm text-sm">
      Assigned class and section
      <select
        className="input mt-2"
        aria-label="Assigned class and section"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Select a class</option>
        {classes.map((c) => (
          <option key={c.id} value={c.id}>
            Class {c.grade} · Section {c.section}
            {c.is_class_teacher ? ' · Class Teacher' : ''}
          </option>
        ))}
      </select>
    </label>
  );
}
export function TeacherRoster() {
  const a = useAuth(),
    classes = useTeachingClasses(),
    [classId, setClassId] = useState(''),
    [page, setPage] = useState(1),
    [profile, setProfile] = useState<string>();
  const students = useQuery({
    queryKey: [a.school, 'teaching-roster', classId, page],
    queryFn: () => api<Rows>(`/resources/students?class_id=${classId}&page=${page}`),
    enabled: !!classId,
  });
  const parents = useQuery({
    queryKey: [a.school, 'teaching-parents', classId, page],
    queryFn: () => api<Rows>(`/resources/parents?class_id=${classId}&page=${page}`),
    enabled: !!classId,
  });
  return (
    <>
      <PageHeading
        title="Your students and their families."
        description="Choose one of your assigned classes to view its learners and authorized parent contacts."
      />
      {classes.error ? (
        <ErrorState error={classes.error} />
      ) : classes.isLoading ? (
        <Loading />
      ) : (
        <ClassChoice
          classes={classes.data?.data || []}
          value={classId}
          onChange={(id) => {
            setClassId(id);
            setPage(1);
          }}
        />
      )}
      {!classId ? (
        <Empty title="Choose an assigned class" />
      ) : (
        <div className="mt-6 space-y-6">
          <Panel title="Students">
            {students.isLoading ? (
              <Loading />
            ) : students.error ? (
              <ErrorState error={students.error} />
            ) : (
              <DataTable
                rows={students.data?.data || []}
                columns={['student_code', 'first_name', 'last_name', 'status']}
                renderCell={(column, row) =>
                  column === 'first_name' ? (
                    <span className="flex items-center gap-2">
                      <PersonAvatar
                        kind="student"
                        id={String(row.id)}
                        photo={row.profile_photo_id as string | null}
                        name={`${row.first_name || ''} ${row.last_name || ''}`}
                        decorative
                      />
                      <span>{String(row.first_name || '')}</span>
                    </span>
                  ) : undefined
                }
                actions={(r) => (
                  <Button size="sm" variant="outline" onClick={() => setProfile(String(r.id))}>
                    Profile
                  </Button>
                )}
              />
            )}
          </Panel>
          <Panel title="Authorized parents and guardians">
            {parents.isLoading ? (
              <Loading />
            ) : parents.error ? (
              <ErrorState error={parents.error} />
            ) : (
              <DataTable
                rows={parents.data?.data || []}
                columns={['full_name', 'email', 'phone']}
              />
            )}
          </Panel>
          <div className="flex gap-2">
            <Button variant="outline" disabled={page === 1} onClick={() => setPage(page - 1)}>
              Previous
            </Button>
            <span className="self-center text-sm">Page {page}</span>
            <Button
              variant="outline"
              disabled={page * 25 >= Math.max(students.data?.total || 0, parents.data?.total || 0)}
              onClick={() => setPage(page + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
      {profile && <StudentProfileDialog studentId={profile} close={() => setProfile(undefined)} />}
    </>
  );
}

export function TeacherAssessments({ kind }: { kind: 'SUBJECT_TEST' | 'OFFICIAL' }) {
  const a = useAuth(),
    qc = useQueryClient(),
    classes = useTeachingClasses(),
    [classId, setClassId] = useState(''),
    [subject, setSubject] = useState(''),
    [page, setPage] = useState(1),
    [create, setCreate] = useState(false),
    [edit, setEdit] = useState<Record<string, unknown>>(),
    [enter, setEnter] = useState<Record<string, unknown>>(),
    [bulk, setBulk] = useState<string>(),
    [rollEntry, setRollEntry] = useState<string>();
  const options =
    classes.data?.data.filter((c) => kind === 'SUBJECT_TEST' || c.is_class_teacher) || [];
  const selected = options.find((c) => c.id === classId);
  const exams = useQuery({
    queryKey: [a.school, 'teaching-exams', kind, classId, page],
    queryFn: () =>
      api<Rows>(`/resources/exams?assessment_kind=${kind}&class_id=${classId}&page=${page}`),
    enabled: !!classId && !!selected,
  });
  useEffect(() => {
    setClassId('');
    setSubject('');
    setPage(1);
    setEnter(undefined);
    setCreate(false);
  }, [kind]);
  async function refresh() {
    await qc.invalidateQueries({ queryKey: [a.school] });
    setCreate(false);
    setEdit(undefined);
    setEnter(undefined);
  }
  const preset = {
    assessment_kind: kind,
    class_id: classId,
    ...(kind === 'SUBJECT_TEST' ? { subject_id: subject } : {}),
  };
  return (
    <>
      <PageHeading
        title={
          kind === 'SUBJECT_TEST'
            ? 'Subject tests. Clear progress.'
            : 'Official examination results.'
        }
        description={
          kind === 'SUBJECT_TEST'
            ? 'Create tests and record marks only for your assigned classes and subjects.'
            : 'Only the designated Class Teacher can enter or upload official examination marks. School Admin manages the examinations.'
        }
      />
      {classes.error ? (
        <ErrorState error={classes.error} />
      ) : classes.isLoading ? (
        <Loading />
      ) : (
        <ClassChoice
          classes={options}
          value={classId}
          onChange={(id) => {
            setClassId(id);
            setSubject('');
            setPage(1);
          }}
        />
      )}
      {kind === 'SUBJECT_TEST' && selected && (
        <div className="my-5 flex flex-wrap items-end gap-4">
          <label className="block text-sm">
            Assigned subject
            <select
              className="input mt-2"
              aria-label="Assigned subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            >
              <option value="">Select a subject</option>
              {selected.subjects.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <Button variant="lime" disabled={!subject} onClick={() => setCreate(true)}>
            Create subject test
          </Button>
        </div>
      )}
      {!options.length && !classes.isLoading ? (
        <Empty
          title={
            kind === 'OFFICIAL' ? 'No Class Teacher designation' : 'No active teaching assignments'
          }
          description="Your School Admin controls assignments and the Class Teacher designation."
        />
      ) : !selected ? (
        <Empty title="Choose an assigned class" />
      ) : (
        <Panel title={kind === 'SUBJECT_TEST' ? 'Subject tests' : 'Official examinations'}>
          {exams.isLoading ? (
            <Loading />
          ) : exams.error ? (
            <ErrorState error={exams.error} />
          ) : (
            <DataTable
              rows={exams.data?.data || []}
              columns={['name', 'subject_id', 'exam_type', 'max_score', 'status']}
              actions={(r) => (
                <div className="flex flex-wrap gap-2">
                  {kind === 'SUBJECT_TEST' && (
                    <Button size="sm" variant="outline" onClick={() => setEdit(r)}>
                      Edit test
                    </Button>
                  )}
                  <Button size="sm" variant="lime" onClick={() => setEnter(r)}>
                    {r.status === 'OPEN' ? 'Enter marks' : 'View marks'}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={r.status !== 'OPEN'}
                    onClick={() => setBulk(String(r.id))}
                  >
                    Upload marks CSV
                  </Button>
                  {r.status === 'OPEN' && (
                    <Button size="sm" variant="outline" onClick={() => setRollEntry(String(r.id))}>
                      Enter by roll number
                    </Button>
                  )}
                </div>
              )}
            />
          )}
          <div className="mt-4 flex gap-2">
            <Button variant="outline" disabled={page === 1} onClick={() => setPage(page - 1)}>
              Previous
            </Button>
            <span className="self-center text-sm">Page {page}</span>
            <Button
              variant="outline"
              disabled={page * 25 >= (exams.data?.total || 0)}
              onClick={() => setPage(page + 1)}
            >
              Next
            </Button>
          </div>
        </Panel>
      )}
      {(create || edit) && (
        <Dialog
          open
          title={edit ? 'Edit subject test' : 'Create subject test'}
          onOpenChange={(v) => {
            if (!v) {
              setCreate(false);
              setEdit(undefined);
            }
          }}
        >
          <ResourceForm
            resource="exams"
            initial={edit}
            preset={edit ? undefined : preset}
            hiddenFields={['assessment_kind', 'class_id', 'subject_id']}
            done={refresh}
          />
        </Dialog>
      )}
      {enter && <EnterAssessmentMarks exam={enter} kind={kind} close={() => setEnter(undefined)} />}
      {bulk && <BulkMarksDialog open examId={bulk} close={() => setBulk(undefined)} />}
      {rollEntry && (
        <RollMarksDialog key={rollEntry} examId={rollEntry} close={() => setRollEntry(undefined)} />
      )}
    </>
  );
}
function EnterAssessmentMarks({
  exam,
  kind,
  close,
}: {
  exam: Record<string, unknown>;
  kind: 'OFFICIAL' | 'SUBJECT_TEST';
  close: () => void;
}) {
  const a = useAuth(),
    qc = useQueryClient(),
    [page, setPage] = useState(1),
    [adding, setAdding] = useState(false),
    [edit, setEdit] = useState<Record<string, unknown>>();
  const marks = useQuery({
    queryKey: [a.school, 'teaching-marks', exam.id, page],
    queryFn: () => api<Rows>(`/resources/marks?exam_id=${exam.id}&page=${page}`),
  });
  return (
    <Dialog
      open
      title={`Marks · ${exam.name}`}
      onOpenChange={(v) => {
        if (!v) close();
      }}
    >
      <p className="mb-4 text-sm">
        Maximum score: {String(exam.max_score)} <Badge>{kind}</Badge>
      </p>
      {marks.error ? (
        <ErrorState error={marks.error} />
      ) : marks.isLoading ? (
        <Loading />
      ) : (
        <DataTable
          rows={marks.data?.data || []}
          columns={['student_id', 'subject_id', 'score', 'remarks']}
          actions={
            exam.status === 'OPEN'
              ? (r) => (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setEdit(r);
                      setAdding(true);
                    }}
                  >
                    Edit marks
                  </Button>
                )
              : undefined
          }
        />
      )}
      <div className="my-4 flex gap-2">
        <Button variant="outline" disabled={page === 1} onClick={() => setPage(page - 1)}>
          Previous marks
        </Button>
        <span className="self-center text-sm">Page {page}</span>
        <Button
          variant="outline"
          disabled={page * 25 >= (marks.data?.total || 0)}
          onClick={() => setPage(page + 1)}
        >
          Next marks
        </Button>
      </div>
      {exam.status === 'OPEN' && (
        <Button
          className="mt-4"
          variant="lime"
          onClick={() => {
            setEdit(undefined);
            setAdding(true);
          }}
        >
          Add marks
        </Button>
      )}
      {adding && (
        <Dialog
          open
          title="Student marks"
          onOpenChange={(v) => {
            if (!v) setAdding(false);
          }}
        >
          <ResourceForm
            key={String(edit?.id || 'new')}
            resource="marks"
            initial={edit}
            preset={{
              exam_id: exam.id,
              class_id: exam.class_id,
              assessment_kind: kind,
              ...(kind === 'SUBJECT_TEST' ? { subject_id: exam.subject_id } : {}),
            }}
            hiddenFields={kind === 'SUBJECT_TEST' ? ['exam_id', 'subject_id'] : ['exam_id']}
            done={async () => {
              await qc.invalidateQueries({ queryKey: [a.school] });
              setAdding(false);
            }}
          />
        </Dialog>
      )}
    </Dialog>
  );
}
