import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCheck, UserX, Clock3, Users, Save, Check } from 'lucide-react';
import type { Page, AttendanceStatus } from '@vidyalayaa/contracts';
import { api, useAuth } from '../../lib/auth';
import { Dialog } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import RecordSelect from '../../components/RecordSelect';
import { Loading, ErrorState } from '../../components/common';

interface EnrolledStudent {
  id: string;
  student_id: string;
  student_id_label?: string;
  roll_number?: string;
  status: string;
}

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

  // Fetch students enrolled in this class
  const enrollmentsQuery = useQuery({
    queryKey: [a.school, 'class-enrollments', classId],
    queryFn: () =>
      api<Page<EnrolledStudent>>(`/resources/enrollments?class_id=${classId}&page_size=100`),
    enabled: open && !!classId,
  });

  // Fetch current attendance for this class and date to prefill
  const existingAttendanceQuery = useQuery({
    queryKey: [a.school, 'existing-attendance', classId, date],
    queryFn: () =>
      api<Page<{ student_id: string; attendance_status: AttendanceStatus }>>(
        `/attendance?class_id=${classId}&date=${date}&page_size=100`,
      ),
    enabled: open && !!classId && !!date,
  });

  // Update initial statuses once data is loaded
  useEffect(() => {
    if (enrollmentsQuery.data?.data) {
      const initial: Record<string, AttendanceStatus> = {};
      const existingMap = new Map(
        existingAttendanceQuery.data?.data?.map((e) => [e.student_id, e.attendance_status]) || [],
      );

      enrollmentsQuery.data.data
        .filter((e) => e.status === 'ACTIVE')
        .forEach((e) => {
          initial[e.student_id] = existingMap.get(e.student_id) || 'PRESENT';
        });

      setStatuses(initial);
    }
  }, [enrollmentsQuery.data, existingAttendanceQuery.data]);

  const setAll = (status: AttendanceStatus) => {
    setStatuses((prev) => {
      const next = { ...prev };
      Object.keys(next).forEach((id) => {
        next[id] = status;
      });
      return next;
    });
  };

  const markStudent = (studentId: string, status: AttendanceStatus) => {
    setStatuses((prev) => ({ ...prev, [studentId]: status }));
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      setError('');
      const records = Object.entries(statuses).map(([student_id, status]) => ({
        student_id,
        status,
      }));
      if (!records.length) throw new Error('No active students in this class.');
      return api('/attendance/bulk', {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({
          class_id: classId,
          date,
          records,
          reason,
        }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [a.school] });
      close();
    },
    onError: (e) => setError((e as Error).message),
  });

  const students = enrollmentsQuery.data?.data.filter((e) => e.status === 'ACTIVE') || [];

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) close();
      }}
      title="Classroom Attendance Register"
      description="Record or update full-class attendance in one batch."
    >
      <div className="space-y-5">
        {/* Class and Date Header Filters */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="field-label" htmlFor="bulk-class-select">
              Select Class & Section
            </label>
            <RecordSelect
              id="bulk-class-select"
              name="class_id"
              endpoint="/resources/classes"
              value={classId}
              onChange={(v) => setClassId(v)}
              label="class"
            />
          </div>
          <div>
            <label className="field-label" htmlFor="bulk-date-select">
              Attendance Date
            </label>
            <input
              id="bulk-date-select"
              type="date"
              className="input w-full"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              required
            />
          </div>
        </div>

        {classId ? (
          enrollmentsQuery.isLoading ? (
            <Loading />
          ) : enrollmentsQuery.error ? (
            <ErrorState error={enrollmentsQuery.error} retry={() => enrollmentsQuery.refetch()} />
          ) : students.length ? (
            <div className="space-y-4">
              {/* Quick Actions Bar */}
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-stone-50 p-3 border border-stone-100">
                <span className="text-xs font-semibold text-stone-600">
                  {students.length} Learners Enrolled
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="text-xs text-green-800 hover:bg-green-50 border-green-200"
                    onClick={() => setAll('PRESENT')}
                  >
                    <CheckCheck size={14} className="text-green-600" />
                    All Present
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="text-xs text-rose-800 hover:bg-rose-50 border-rose-200"
                    onClick={() => setAll('ABSENT')}
                  >
                    <UserX size={14} className="text-rose-600" />
                    All Absent
                  </Button>
                </div>
              </div>

              {/* Student Attendance List */}
              <div className="max-h-72 overflow-y-auto rounded-xl border border-stone-200 divide-y divide-stone-100">
                {students.map((s, index) => {
                  const currentStatus = statuses[s.student_id] || 'PRESENT';
                  return (
                    <div
                      key={s.id}
                      className="flex items-center justify-between p-3 text-xs hover:bg-stone-50/70"
                    >
                      <div className="flex items-center gap-3">
                        <span className="w-6 text-center font-mono text-stone-400">
                          {s.roll_number || `#${index + 1}`}
                        </span>
                        <div>
                          <p className="font-semibold text-stone-900">
                            {s.student_id_label || 'Student'}
                          </p>
                        </div>
                      </div>

                      {/* Status Toggle Pills */}
                      <div className="flex items-center gap-1">
                        {(['PRESENT', 'LATE', 'HALF_DAY', 'ABSENT', 'EXCUSED'] as const).map(
                          (status) => {
                            const isSelected = currentStatus === status;
                            return (
                              <button
                                key={status}
                                type="button"
                                className={`rounded px-2 py-1 font-semibold transition-all text-[11px] ${
                                  isSelected
                                    ? status === 'PRESENT'
                                      ? 'bg-green-600 text-white shadow-xs'
                                      : status === 'LATE'
                                        ? 'bg-amber-500 text-white shadow-xs'
                                        : status === 'ABSENT'
                                          ? 'bg-rose-600 text-white shadow-xs'
                                          : 'bg-stone-800 text-white shadow-xs'
                                    : 'bg-stone-100 text-stone-600 hover:bg-stone-200'
                                }`}
                                onClick={() => markStudent(s.student_id, status)}
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
                            );
                          },
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Reason for batch entry */}
              <div>
                <label className="field-label text-xs" htmlFor="bulk-reason">
                  Register Note / Reason
                </label>
                <input
                  id="bulk-reason"
                  className="input mt-1 w-full text-xs"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. Daily morning roll call"
                  required
                />
              </div>

              {error && <p className="field-error">{error}</p>}

              {/* Submit Buttons */}
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="outline" onClick={close}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="lime"
                  disabled={saveMutation.isPending}
                  onClick={() => saveMutation.mutate()}
                >
                  <Save size={14} />
                  {saveMutation.isPending ? 'Saving Register…' : 'Save Class Attendance'}
                </Button>
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-stone-200 p-8 text-center text-sm text-stone-500">
              No active students enrolled in this class.
            </div>
          )
        ) : (
          <div className="rounded-xl border border-dashed border-stone-200 p-8 text-center text-sm text-stone-500">
            Select a class above to open its attendance register.
          </div>
        )}
      </div>
    </Dialog>
  );
}
