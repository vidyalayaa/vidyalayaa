import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Clock, Plus } from 'lucide-react';
import type { TimetableClass, TimetableEntry, TimetableSettings } from '@vidyalayaa/contracts';
import { api, useAuth } from '../../lib/auth';
import { PageHeading, Loading, ErrorState, Empty } from '../../components/common';
import { Button } from '../../components/ui/button';
import { ActionDialog } from '../../components/ActionDialog';
import { timetablePages } from './timetable-api';
import { clock, overlaps, timetableRows, weekdays } from './timetable-utils';
import TimingForm from './TimingForm';
import LectureForm from './LectureForm';

export default function Timetable() {
  const a = useAuth(),
    qc = useQueryClient(),
    [classId, setClassId] = useState(''),
    [timing, setTiming] = useState(false),
    [editing, setEditing] = useState<{ entry?: TimetableEntry; day?: number; number?: number }>(),
    [deleting, setDeleting] = useState<TimetableEntry>();
  const allowed =
      !!a.me?.school?.permissions.includes('timetable.read') && !!a.me?.features.timetable,
    manage =
      a.me?.school?.role === 'school_admin' &&
      !!a.me.school.permissions.includes('timetable.write');
  const classes = useQuery({
    queryKey: [a.school, 'timetable-classes'],
    queryFn: ({ signal }) => timetablePages<TimetableClass>('/timetable/classes', signal),
    enabled: allowed,
  });
  const config = useQuery({
    queryKey: [a.school, 'timetable-settings'],
    queryFn: () => api<TimetableSettings>('/timetable/settings'),
    enabled: allowed,
  });
  const classroom = classes.data?.find((c) => c.id === classId);
  const entries = useQuery({
    queryKey: [a.school, 'timetable-entries', classId],
    queryFn: ({ signal }) =>
      timetablePages<TimetableEntry>(`/timetable/classes/${classId}/entries`, signal),
    enabled: allowed && !!classroom,
  });
  useEffect(() => {
    if (classes.data?.length === 1 && !classId) setClassId(classes.data[0].id);
  }, [classes.data, classId]);
  if (!allowed)
    return (
      <Empty
        title="Timetable unavailable"
        description="Choose an eligible school workspace to view its timetable."
      />
    );
  const rows = config.data ? timetableRows(config.data.settings, entries.data || []) : [],
    days = [
      ...new Set([
        ...(config.data?.settings.days || []),
        ...(entries.data || []).map((e) => e.weekday),
      ]),
    ].sort((a, b) => a - b);
  const hasLegacy =
    rows.some((r) => r.kind === 'legacy') ||
    (entries.data || []).some((e) => !config.data?.settings.days.includes(e.weekday));
  return (
    <>
      <PageHeading
        title="Your school week, clearly planned."
        description="Class subjects, assigned teachers and lecture times in one weekly view."
        actions={
          manage && (
            <Button variant="outline" onClick={() => setTiming(true)} disabled={!config.data}>
              <Clock size={16} />
              School timings
            </Button>
          )
        }
      />
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4 rounded-2xl border border-stone-200 bg-white p-5">
        <div className="w-full sm:max-w-md">
          <label className="field-label" htmlFor="timetable-class">
            Class and section
          </label>
          <select
            id="timetable-class"
            className="input"
            value={classId}
            disabled={classes.isLoading}
            onChange={(e) => {
              setClassId(e.target.value);
              setEditing(undefined);
              setDeleting(undefined);
            }}
          >
            <option value="">Select a class and section</option>
            {classes.data?.map((c) => (
              <option value={c.id} key={c.id}>
                Class {c.grade} · Section {c.section} · {c.session_name}
              </option>
            ))}
          </select>
        </div>
        {manage && (
          <Button
            variant="lime"
            disabled={!classroom || !config.data?.configured}
            onClick={() => setEditing({})}
          >
            <Plus size={16} />
            Add lecture
          </Button>
        )}
      </div>
      {classes.error ? (
        <ErrorState error={classes.error} retry={() => classes.refetch()} />
      ) : config.error ? (
        <ErrorState error={config.error} retry={() => config.refetch()} />
      ) : classes.isLoading || config.isLoading ? (
        <Loading />
      ) : !classes.data?.length ? (
        <Empty
          title="No classes available"
          description="Your timetable follows your school's classes and current assignments or enrollment."
        />
      ) : !classroom ? (
        <Empty
          title="Choose a class and section"
          description="Each class and section has its own weekly timetable."
        />
      ) : (
        <>
          {!config.data?.configured && (
            <p className="notice mb-5">
              School timings have not been saved yet.
              {manage
                ? ' Use School timings to set school days and lecture periods before adding lectures.'
                : ' Your School Admin will configure school days and lecture periods.'}
            </p>
          )}
          {hasLegacy && (
            <p className="mb-5 rounded-xl bg-amber-50 p-4 text-sm text-amber-900">
              Some existing lectures use times or days outside the current school timings. They are
              shown below with their original times.
              {manage ? ' Edit a lecture to move it into a current period.' : ''}
            </p>
          )}
          {entries.isLoading ? (
            <Loading />
          ) : entries.error ? (
            <ErrorState error={entries.error} retry={() => entries.refetch()} />
          ) : (
            <section
              aria-label="Weekly class timetable"
              className="min-w-0 rounded-2xl border border-stone-200 bg-white p-4 sm:p-6"
            >
              <h2 className="mb-4 flex flex-wrap items-center gap-2 text-lg font-semibold">
                <CalendarDays size={20} />
                Class {classroom.grade} · Section {classroom.section}
                <span className="text-sm font-normal text-stone-500">{classroom.session_name}</span>
              </h2>
              <div className="max-w-full overflow-x-auto rounded-xl border border-stone-200">
                <table className="w-full min-w-[900px] border-collapse text-sm">
                  <caption className="sr-only">
                    Weekly timetable for Class {classroom.grade} Section {classroom.section}. Times
                    use the school's local timezone.
                  </caption>
                  <thead>
                    <tr className="bg-stone-50">
                      <th
                        scope="col"
                        className="sticky left-0 z-20 w-36 border-b border-stone-200 bg-stone-50 p-3 text-left"
                      >
                        Lecture / time
                      </th>
                      {days.map((d) => (
                        <th
                          key={d}
                          scope="col"
                          className="border-b border-l border-stone-200 p-3 text-left"
                        >
                          {weekdays[d - 1]}
                          {!config.data?.settings.days.includes(d) && (
                            <span className="block text-xs font-normal">Existing lectures</span>
                          )}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.key} className={row.kind === 'break' ? 'bg-lime-50/60' : ''}>
                        <th
                          scope="row"
                          className="sticky left-0 z-10 border-b border-stone-200 bg-white p-3 text-left align-top"
                        >
                          <span className="block font-semibold">{row.label}</span>
                          <span className="mt-1 block text-xs font-normal text-stone-600">
                            {row.start_time}–{row.end_time}
                          </span>
                          {row.kind === 'legacy' && (
                            <span className="mt-1 block text-xs font-normal text-amber-800">
                              Original timing
                            </span>
                          )}
                        </th>
                        {row.kind === 'break' ? (
                          <td
                            colSpan={days.length}
                            className="border-b border-l border-stone-200 p-3 text-center text-sm text-stone-600"
                          >
                            {row.label}
                          </td>
                        ) : (
                          days.map((d) => {
                            const entry = entries.data?.find(
                                (e) =>
                                  e.weekday === d &&
                                  clock(e.starts_at) === row.start_time &&
                                  clock(e.ends_at) === row.end_time,
                              ),
                              busy = entries.data?.some((e) => e.weekday === d && overlaps(e, row)),
                              canAdd =
                                manage &&
                                config.data?.configured &&
                                row.kind === 'period' &&
                                config.data.settings.days.includes(d) &&
                                !busy;
                            return (
                              <td
                                key={d}
                                className="min-w-36 border-b border-l border-stone-200 p-2 align-top"
                              >
                                {entry ? (
                                  <article
                                    aria-label={`${weekdays[d - 1]} ${row.label}: ${entry.subject_label}`}
                                    className="rounded-lg bg-stone-50 p-3"
                                  >
                                    <h3 className="break-words font-semibold">
                                      {entry.subject_label}
                                    </h3>
                                    <p className="mt-1 break-words text-xs text-stone-600">
                                      {entry.teacher_label}
                                    </p>
                                    {entry.room && (
                                      <p className="mt-1 text-xs text-stone-500">
                                        Room {entry.room}
                                      </p>
                                    )}
                                    {manage && (
                                      <>
                                        <p className="mt-1 text-xs text-amber-800">
                                          {!entry.assignment_valid ? 'Assignment needs review' : ''}
                                        </p>
                                        <div className="mt-3 flex flex-wrap gap-2">
                                          <Button
                                            size="sm"
                                            variant="outline"
                                            aria-label={`Edit lecture ${weekdays[d - 1]} ${row.label}`}
                                            onClick={() => setEditing({ entry })}
                                          >
                                            Edit
                                          </Button>
                                          <Button
                                            size="sm"
                                            variant="ghost"
                                            aria-label={`Delete lecture ${weekdays[d - 1]} ${row.label}`}
                                            onClick={() => setDeleting(entry)}
                                          >
                                            Delete
                                          </Button>
                                        </div>
                                      </>
                                    )}
                                  </article>
                                ) : canAdd ? (
                                  <Button
                                    className="min-h-20 w-full"
                                    size="sm"
                                    variant="ghost"
                                    aria-label={`Add lecture ${weekdays[d - 1]} ${row.label}`}
                                    onClick={() => setEditing({ day: d, number: row.number })}
                                  >
                                    <Plus size={14} />
                                    Add lecture
                                  </Button>
                                ) : (
                                  <p className="p-3 text-xs text-stone-500">
                                    {busy ? 'Overlaps an existing lecture' : 'No lecture'}
                                  </p>
                                )}
                              </td>
                            );
                          })
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-4 text-xs text-stone-500">
                Times are shown in {a.me?.school?.timezone || 'your school timezone'}.{' '}
                {manage
                  ? 'Choose an empty lecture period to assign a class subject and its teacher.'
                  : 'Your School Admin manages lecture assignments and school timings.'}
              </p>
            </section>
          )}
        </>
      )}
      {timing && config.data && <TimingForm initial={config.data} close={() => setTiming(false)} />}
      {editing && classroom && config.data && (
        <LectureForm
          classroom={classroom}
          settings={config.data.settings}
          {...editing}
          close={() => setEditing(undefined)}
        />
      )}
      {deleting && (
        <ActionDialog
          open
          close={() => {
            setDeleting(undefined);
            qc.invalidateQueries({ queryKey: [a.school] });
          }}
          title="Delete lecture"
          endpoint={`/resources/timetable_entries/${deleting.id}/retire`}
          fields={[{ key: 'reason', type: 'textarea' }]}
        />
      )}
    </>
  );
}
