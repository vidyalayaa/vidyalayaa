import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  AttendanceCalendarDay,
  AttendanceCalendarRecord,
  AttendanceCalendarState,
} from '@vidyalayaa/contracts';
import { attendanceStatuses } from '@vidyalayaa/contracts';
import { api, useAuth } from '../../lib/auth';
import { display } from '../../lib/utils';
import { ActionDialog } from '../../components/ActionDialog';
import { DataTable, Empty, ErrorState, Loading } from '../../components/common';
import Pagination from '../../components/Pagination';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { prettyDate } from '../calendar/calendar-utils';
import { dayDescription, summarizeAttendance } from './attendance-calendar-utils';

export function AttendanceDayDialog({
  base,
  filters,
  date,
  day,
  today,
  status,
  onClose,
  onRegister,
  canCorrect,
}: {
  base: string;
  filters: string;
  date: string;
  day?: AttendanceCalendarDay;
  today: string;
  status: AttendanceCalendarState | '';
  onClose: () => void;
  onRegister?: () => void;
  canCorrect?: (classId: string) => boolean;
}) {
  const a = useAuth();
  const [page, setPage] = useState(1);
  const [correction, setCorrection] = useState<AttendanceCalendarRecord | null>(null);
  const params = new URLSearchParams(filters);
  params.set('date', date);
  params.set('page', String(page));
  params.set('page_size', '25');
  if (attendanceStatuses.some((value) => value === status)) params.set('status', status);
  const records = useQuery({
    queryKey: [a.school, 'attendance-calendar-detail', base, params.toString()],
    queryFn: ({ signal }) =>
      api<{ data: AttendanceCalendarRecord[]; total: number; page_size: number }>(
        `${base}/day?${params}`,
        { signal },
      ),
    enabled: date <= today,
  });
  const summary = day && summarizeAttendance([day]);
  const data = records.data?.data || [];
  const allowed = !!a.me?.school?.permissions.includes('attendance.correct_request');
  return (
    <>
      <Dialog
        open={!correction}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        title={`Attendance for ${prettyDate(date)}`}
        description={dayDescription(date, today, day)}
      >
        <div className="space-y-4">
          {day && (
            <p className="text-sm text-stone-700">
              {day.working > 0 && (
                <>
                  {day.working} scheduled · {day.present} present · {day.absent} absent ·{' '}
                  {day.half_day} half day · {day.late} late · {day.excused} excused · {day.pending}{' '}
                  pending · {day.unmarked} unmarked
                  {summary?.percentage != null && ` · ${summary.percentage}% attendance`}
                </>
              )}
              {(day.holidays > 0 || day.weekly_off > 0) && (
                <span className="block">
                  {day.holidays} holiday · {day.weekly_off} weekly off
                  {day.holiday_names.length ? ` · ${day.holiday_names.join(', ')}` : ''}
                </span>
              )}
            </p>
          )}
          {date > today ? (
            <Empty
              title="Future date"
              description="Attendance is available once this school day arrives."
            />
          ) : records.isLoading ? (
            <Loading />
          ) : records.error ? (
            <ErrorState error={records.error} retry={() => records.refetch()} />
          ) : data.length ? (
            <>
              <DataTable
                rows={data.map((row) => ({
                  ...row,
                  student: [row.first_name, row.last_name, row.student_code]
                    .filter(Boolean)
                    .join(' '),
                  class_section: row.grade ? `Class ${row.grade} · ${row.section}` : '—',
                  arrival: row.first_arrival_at
                    ? display(row.first_arrival_at, a.me?.school?.timezone)
                    : '—',
                  departure: row.last_departure_at
                    ? display(row.last_departure_at, a.me?.school?.timezone)
                    : '—',
                }))}
                columns={[
                  'student',
                  'class_section',
                  'attendance_status',
                  'movement_status',
                  'arrival',
                  'departure',
                ]}
                actions={
                  allowed
                    ? (row) => {
                        const record = data.find((item) => item.id === row.id);
                        return record && (canCorrect?.(record.class_id) ?? true) ? (
                          <Button size="sm" variant="outline" onClick={() => setCorrection(record)}>
                            Request correction
                          </Button>
                        ) : null;
                      }
                    : undefined
                }
              />
              <Pagination
                page={page}
                total={records.data?.total}
                pageSize={records.data?.page_size}
                onPage={setPage}
              />
            </>
          ) : (
            <Empty
              title={day?.working ? 'No matching attendance records' : 'No attendance records'}
              description={
                day?.unmarked
                  ? 'The school has yet to mark attendance for some students on this date.'
                  : 'There are no records for this date and selection.'
              }
            />
          )}
          {onRegister && date <= today && (
            <Button
              variant="outline"
              onClick={() => {
                onClose();
                onRegister();
              }}
            >
              Open daily register
            </Button>
          )}
        </div>
      </Dialog>
      {correction && (
        <ActionDialog
          open
          close={() => setCorrection(null)}
          title={`Request attendance correction · ${correction.first_name}`}
          endpoint="/corrections"
          fields={[
            { key: 'daily_attendance_id', type: 'hidden', default: correction.id },
            {
              key: 'requested_status',
              options: attendanceStatuses.filter((value) => value !== 'PENDING'),
              default:
                correction.attendance_status === 'PENDING'
                  ? 'PRESENT'
                  : correction.attendance_status,
            },
            { key: 'reason', type: 'textarea' },
          ]}
        />
      )}
    </>
  );
}
