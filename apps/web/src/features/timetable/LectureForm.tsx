import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  resourceSchemas,
  type SchoolTimings,
  type TimetableAssignment,
  type TimetableClass,
  type TimetableEntry,
} from '@vidyalayaa/contracts';
import { api, useAuth } from '../../lib/auth';
import { useUnsavedChanges } from '../../lib/use-unsaved-changes';
import { Dialog } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { Loading, ErrorState } from '../../components/common';
import { timetablePages } from './timetable-api';
import { clock, weekdays } from './timetable-utils';

export default function LectureForm({
  classroom,
  settings,
  entry,
  day,
  number,
  close,
}: {
  classroom: TimetableClass;
  settings: SchoolTimings;
  entry?: TimetableEntry;
  day?: number;
  number?: number;
  close: () => void;
}) {
  const a = useAuth(),
    qc = useQueryClient(),
    [timings] = useState(settings),
    [weekday, setWeekday] = useState(entry?.weekday || day || settings.days[0]),
    [period, setPeriod] = useState(
      entry
        ? String(
            settings.periods.find(
              (p) => p.start_time === clock(entry.starts_at) && p.end_time === clock(entry.ends_at),
            )?.number || 'legacy',
          )
        : String(number || settings.periods[0].number),
    ),
    [subject, setSubject] = useState(entry?.subject_id || ''),
    [teacher, setTeacher] = useState(entry?.teacher_id || ''),
    [room, setRoom] = useState(entry?.room || ''),
    [dirty, setDirty] = useState(false),
    [error, setError] = useState('');
  const retry = useRef({ body: '', key: crypto.randomUUID() });
  useUnsavedChanges(dirty);
  const assignments = useQuery({
    queryKey: [a.school, 'timetable-assignments', classroom.id],
    queryFn: ({ signal }) =>
      timetablePages<TimetableAssignment>(`/timetable/classes/${classroom.id}/assignments`, signal),
  });
  const subjects = [
      ...new Map(
        (assignments.data || []).map((p) => [
          p.subject_id,
          { id: p.subject_id, label: p.subject_label },
        ]),
      ).values(),
    ],
    teachers = (assignments.data || []).filter((p) => p.subject_id === subject);
  const mutation = useMutation({
    mutationFn: () => {
      const selected = timings.periods.find((p) => String(p.number) === period),
        values = resourceSchemas.timetable_entries.parse({
          class_id: classroom.id,
          subject_id: subject,
          teacher_id: teacher,
          weekday,
          starts_at: selected?.start_time || entry?.starts_at,
          ends_at: selected?.end_time || entry?.ends_at,
          room: room.trim() || null,
        }),
        body = JSON.stringify(values);
      if (retry.current.body !== body) retry.current = { body, key: crypto.randomUUID() };
      return api('/resources/timetable_entries' + (entry ? '/' + entry.id : ''), {
        method: entry ? 'PATCH' : 'POST',
        headers: { 'Idempotency-Key': retry.current.key },
        body,
      });
    },
    onSuccess: async () => {
      setDirty(false);
      await qc.invalidateQueries({ queryKey: [a.school] });
      close();
    },
    onError: (e: Error & { issues?: { message: string }[] }) =>
      setError(e.issues?.map((i) => i.message).join(' ') || e.message),
  });
  const requestClose = () => {
    if (!mutation.isPending && (!dirty || window.confirm('Discard unsaved lecture details?')))
      close();
  };
  const days = [...new Set([...timings.days, ...(entry ? [entry.weekday] : [])])].sort(
    (a, b) => a - b,
  );
  return (
    <Dialog
      open
      title={entry ? 'Edit lecture' : 'Add lecture'}
      description={`Class ${classroom.grade} · Section ${classroom.section} · ${classroom.session_name}`}
      onOpenChange={(v) => {
        if (!v) requestClose();
      }}
    >
      {assignments.isLoading ? (
        <Loading />
      ) : assignments.error ? (
        <ErrorState error={assignments.error} retry={() => assignments.refetch()} />
      ) : (
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            setError('');
            mutation.mutate();
          }}
        >
          <fieldset disabled={mutation.isPending} className="min-w-0 space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="text-sm" htmlFor="lecture-day">
                Day
                <select
                  id="lecture-day"
                  className="input mt-2"
                  value={weekday}
                  disabled={period === 'legacy'}
                  onChange={(e) => {
                    setWeekday(Number(e.target.value));
                    setDirty(true);
                  }}
                >
                  {days.map((d) => (
                    <option key={d} value={d}>
                      {weekdays[d - 1]}
                      {!timings.days.includes(d) ? ' (existing lecture)' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm" htmlFor="lecture-period">
                Lecture period
                <select
                  id="lecture-period"
                  className="input mt-2"
                  required
                  value={period}
                  onChange={(e) => {
                    setPeriod(e.target.value);
                    setDirty(true);
                  }}
                >
                  {period === 'legacy' && entry && (
                    <option value="legacy">
                      Keep existing times: {clock(entry.starts_at)}–{clock(entry.ends_at)}
                    </option>
                  )}
                  {timings.periods.map((p) => (
                    <option key={p.number} value={p.number}>
                      {p.label} · {p.start_time}–{p.end_time}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="block text-sm" htmlFor="lecture-subject">
              Subject
              <select
                id="lecture-subject"
                className="input mt-2"
                required
                value={subject}
                onChange={(e) => {
                  setSubject(e.target.value);
                  setTeacher('');
                  setDirty(true);
                }}
              >
                <option value="">Select a class subject</option>
                {subjects.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
                {entry && !subjects.some((s) => s.id === entry.subject_id) && (
                  <option value={entry.subject_id}>
                    {entry.subject_label} (previous assignment)
                  </option>
                )}
              </select>
            </label>
            <label className="block text-sm" htmlFor="lecture-teacher">
              Assigned teacher
              <select
                id="lecture-teacher"
                className="input mt-2"
                required
                disabled={!subject}
                value={teacher}
                onChange={(e) => {
                  setTeacher(e.target.value);
                  setDirty(true);
                }}
              >
                <option value="">
                  {subject ? 'Select an assigned teacher' : 'Choose a subject first'}
                </option>
                {teachers.map((t) => (
                  <option key={t.teacher_id} value={t.teacher_id}>
                    {t.teacher_label}
                  </option>
                ))}
                {entry &&
                  subject === entry.subject_id &&
                  !teachers.some((t) => t.teacher_id === entry.teacher_id) && (
                    <option value={entry.teacher_id}>
                      {entry.teacher_label} (previous assignment)
                    </option>
                  )}
              </select>
            </label>
            <label className="block text-sm" htmlFor="lecture-room">
              Room (optional)
              <input
                id="lecture-room"
                className="input mt-2"
                value={room}
                maxLength={1000}
                onChange={(e) => {
                  setRoom(e.target.value);
                  setDirty(true);
                }}
              />
            </label>
            {!assignments.data?.length && (
              <p className="text-sm text-stone-600">
                No active subject-teacher assignments are configured for this class. Assign them in
                Academics before adding lectures.
              </p>
            )}
          </fieldset>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={requestClose}
              disabled={mutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="lime"
              disabled={mutation.isPending || (!entry && !assignments.data?.length)}
            >
              {mutation.isPending ? 'Saving…' : 'Save lecture'}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
