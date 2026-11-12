import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Page, AttendanceStatus } from '@vidyalayaa/contracts';
import { classAttendanceSchema } from '@vidyalayaa/contracts';
import { api, useAuth } from '../../lib/auth';
import { Dialog } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import RecordSelect from '../../components/RecordSelect';
import { Loading, ErrorState } from '../../components/common';
import { useTeachingClasses } from '../../lib/use-teaching-classes';

type Enrollment = {
  id: string;
  student_id: string;
  student_label?: string;
  roll_number?: string;
  status: string;
  starts_on: string;
  ends_on?: string | null;
};
type Day = {
  student_id: string;
  attendance_status: AttendanceStatus;
  source: string;
  version: number;
};
async function all<T>(endpoint: string): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 1; ; page++) {
    const result = await api<Page<T>>(`${endpoint}&page_size=100&page=${page}`);
    if (result.total > 500)
      throw new Error(
        'This register supports up to 500 records. Use individual attendance for larger classes.',
      );
    rows.push(...result.data);
    if (rows.length >= result.total || !result.data.length) return rows;
  }
}
const choices = ['PRESENT', 'LATE', 'HALF_DAY', 'ABSENT', 'EXCUSED'] as const;
export default function ClassAttendanceSheet({
  open,
  close,
  initialClassId,
  initialDate,
}: {
  open: boolean;
  close: () => void;
  initialClassId?: string;
  initialDate?: string;
}) {
  const teaching = useTeachingClasses();
  const a = useAuth(),
    qc = useQueryClient(),
    [classId, setClassId] = useState(initialClassId || ''),
    [date, setDate] = useState(
      initialDate ||
        new Intl.DateTimeFormat('en-CA', {
          timeZone: a.me?.school?.timezone || 'Asia/Kolkata',
        }).format(new Date()),
    ),
    [reason, setReason] = useState('Classroom register roll call'),
    [statuses, setStatuses] = useState<Record<string, AttendanceStatus>>({}),
    [error, setError] = useState('');
  const retry = useRef({ body: '', key: crypto.randomUUID() });
  const enrollments = useQuery({
    queryKey: [a.school, 'class-enrollments', classId],
    queryFn: () => all<Enrollment>(`/resources/enrollments?class_id=${classId}`),
    enabled: open && !!classId,
    refetchOnWindowFocus: false,
  });
  const attendance = useQuery({
    queryKey: [a.school, 'existing-attendance', classId, date],
    queryFn: () => all<Day>(`/attendance?class_id=${classId}&date=${date}`),
    enabled: open && !!classId && !!date,
    refetchOnWindowFocus: false,
  });
  const students =
    enrollments.data?.filter(
      (e) => e.starts_on.slice(0, 10) <= date && (!e.ends_on || e.ends_on.slice(0, 10) >= date),
    ) || [];
  const days = new Map(attendance.data?.map((d) => [d.student_id, d]) || []);
  const protectedRecord = (id: string) => {
    const d = days.get(id);
    return d?.source === 'NFC' && d.version > 0;
  };
  useEffect(() => {
    if (!enrollments.data || !attendance.data) return;
    const prior = new Map(attendance.data.map((d) => [d.student_id, d.attendance_status]));
    setStatuses(
      Object.fromEntries(
        enrollments.data.map((e) => [
          e.student_id,
          prior.get(e.student_id) === 'PENDING' ? 'PRESENT' : prior.get(e.student_id) || 'PRESENT',
        ]),
      ),
    );
  }, [enrollments.data, attendance.data, classId, date]);
  const save = useMutation({
    mutationFn: async () => {
      const body = JSON.stringify(
        classAttendanceSchema.parse({
          class_id: classId,
          date,
          reason,
          records: students
            .filter((s) => !protectedRecord(s.student_id))
            .map((s) => ({
              student_id: s.student_id,
              status: statuses[s.student_id] || 'PRESENT',
              expected_version: days.get(s.student_id)?.version || 0,
            })),
        }),
      );
      if (retry.current.body !== body) retry.current = { body, key: crypto.randomUUID() };
      return api('/attendance/bulk', {
        method: 'POST',
        headers: { 'Idempotency-Key': retry.current.key },
        body,
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: [a.school] });
      close();
    },
    onError: (e) => setError(e.message),
  });
  const loading = enrollments.isFetching || attendance.isFetching;
  const problem = enrollments.error || attendance.error;
  const canManage =
    a.me?.school?.role !== 'teacher' ||
    !!teaching.data?.data.some((c) => c.id === classId && c.is_class_teacher);
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && !save.isPending) close();
      }}
      title="Classroom Attendance Register"
      description="Record classroom attendance. NFC records require an approved correction."
    >
      <div className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="field-label" htmlFor="bulk-class-select">
              Select Class &amp; Section
            </label>
            <RecordSelect
              id="bulk-class-select"
              name="class_id"
              endpoint={
                a.me?.school?.role === 'teacher'
                  ? '/resources/classes?class_teacher=1'
                  : '/resources/classes'
              }
              value={classId}
              onChange={(v) => {
                setClassId(v);
                setError('');
              }}
              label="class"
              disabled={save.isPending}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="bulk-date-select">
              Attendance Date
            </label>
            <input
              id="bulk-date-select"
              type="date"
              className="input"
              value={date}
              disabled={save.isPending}
              onChange={(e) => {
                setDate(e.target.value);
                setError('');
              }}
              required
            />
          </div>
        </div>
        {!classId ? (
          <p>Select a class above to open its attendance register.</p>
        ) : !canManage ? (
          <p>Only the designated Class Teacher can manage this class register.</p>
        ) : loading ? (
          <Loading />
        ) : problem ? (
          <ErrorState
            error={problem}
            retry={() => {
              enrollments.refetch();
              attendance.refetch();
            }}
          />
        ) : students.length ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-stone-50 p-3">
              <span className="text-xs font-semibold">{students.length} Learners Enrolled</span>
              <div className="flex gap-2">
                {(['PRESENT', 'ABSENT'] as const).map((status) => (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    key={status}
                    disabled={save.isPending}
                    onClick={() =>
                      setStatuses((prior) => ({
                        ...prior,
                        ...Object.fromEntries(
                          students
                            .filter((s) => !protectedRecord(s.student_id))
                            .map((s) => [s.student_id, status]),
                        ),
                      }))
                    }
                  >
                    {status === 'PRESENT' ? 'All Present' : 'All Absent'}
                  </Button>
                ))}
              </div>
            </div>
            <div className="max-h-72 overflow-y-auto divide-y rounded-xl border">
              {students.map((s, index) => (
                <div
                  key={s.id}
                  className="flex flex-wrap items-center justify-between gap-2 p-3 text-xs"
                >
                  <span>
                    {s.roll_number || `#${index + 1}`} ·{' '}
                    <strong>{s.student_label || 'Student'}</strong>
                  </span>
                  {protectedRecord(s.student_id) ? (
                    <span>
                      NFC · {days.get(s.student_id)?.attendance_status} · correction required
                    </span>
                  ) : (
                    <div
                      className="flex flex-wrap gap-1"
                      role="group"
                      aria-label={`Attendance for ${s.student_label || s.roll_number || index + 1}`}
                    >
                      {choices.map((status) => (
                        <button
                          key={status}
                          type="button"
                          disabled={save.isPending}
                          aria-pressed={statuses[s.student_id] === status}
                          aria-label={status.replaceAll('_', ' ')}
                          className={`rounded px-2 py-1 font-semibold ${statuses[s.student_id] === status ? 'bg-lime-300 text-ink' : 'bg-stone-100 text-stone-700'}`}
                          onClick={() =>
                            setStatuses((prior) => ({ ...prior, [s.student_id]: status }))
                          }
                        >
                          {status === 'PRESENT'
                            ? 'P'
                            : status === 'LATE'
                              ? 'L'
                              : status === 'HALF_DAY'
                                ? 'HD'
                                : status === 'ABSENT'
                                  ? 'A'
                                  : 'E'}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <label className="field-label block">
              Register Note / Reason
              <input
                className="input mt-1"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                required
                minLength={5}
                maxLength={2000}
                disabled={save.isPending}
              />
            </label>
            {error && (
              <p className="field-error" role="alert">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" disabled={save.isPending} onClick={close}>
                Cancel
              </Button>
              <Button
                variant="lime"
                disabled={
                  !canManage ||
                  save.isPending ||
                  reason.trim().length < 5 ||
                  !students.some((s) => !protectedRecord(s.student_id))
                }
                onClick={() => {
                  setError('');
                  save.mutate();
                }}
              >
                {save.isPending ? 'Saving Register…' : 'Save Class Attendance'}
              </Button>
            </div>
          </>
        ) : (
          <p>No students enrolled in this class on the selected date.</p>
        )}
      </div>
    </Dialog>
  );
}
