import { useState } from 'react';
import { useAuth } from '../../lib/auth';
import { useTeachingClasses } from '../../lib/use-teaching-classes';
import { Empty, ErrorState, Loading, PageHeading } from '../../components/common';
import SubjectMaterials, { type MaterialSubject } from './SubjectMaterials';
export default function TeacherMaterials() {
  const a = useAuth(),
    classes = useTeachingClasses(),
    [classId, setClassId] = useState(''),
    [subject, setSubject] = useState<MaterialSubject>();
  const selected = classes.data?.data.find((c) => c.id === classId);
  if (a.me?.school?.role !== 'teacher') return <Empty title="Access unavailable" />;
  return (
    <>
      <PageHeading
        title="Subject study materials"
        description="Share notes and files for your assigned classes and subjects."
      />
      {classes.isLoading ? (
        <Loading />
      ) : classes.error ? (
        <ErrorState error={classes.error} />
      ) : (
        <label className="block max-w-lg text-sm">
          Assigned class and section
          <select
            className="input mt-2"
            aria-label="Assigned class and section"
            value={classId}
            onChange={(e) => {
              setClassId(e.target.value);
              setSubject(undefined);
            }}
          >
            <option value="">Select a class</option>
            {classes.data?.data.map((c) => (
              <option value={c.id} key={c.id}>
                Class {c.grade} · Section {c.section}
              </option>
            ))}
          </select>
        </label>
      )}
      {!selected ? (
        <Empty title="Choose an assigned class" />
      ) : !selected.subjects.length ? (
        <Empty
          title="No subjects assigned"
          description="Ask School Admin to assign your teaching subjects for this class."
        />
      ) : (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {selected.subjects.map((s) => (
            <button
              type="button"
              key={s.id}
              className="rounded-2xl border border-line bg-white p-5 text-left hover:border-lime-500 hover:bg-lime-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-600"
              onClick={() =>
                setSubject({
                  classId: selected.id,
                  subjectId: s.id,
                  name: s.name,
                  classLabel: `Class ${selected.grade} · Section ${selected.section}`,
                })
              }
            >
              <h2 className="font-semibold">{s.name}</h2>
              <p className="mt-2 text-xs text-stone-500">{s.code}</p>
              <p className="mt-4 text-sm">Manage study materials →</p>
            </button>
          ))}
        </div>
      )}
      {subject && (
        <SubjectMaterials
          key={subject.classId + subject.subjectId}
          subject={subject}
          close={() => setSubject(undefined)}
        />
      )}
    </>
  );
}
