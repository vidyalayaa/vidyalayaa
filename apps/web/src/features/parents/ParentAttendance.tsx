import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  parentAttendanceStatuses,
  type ParentAttendanceDay,
  type ParentAttendanceResponse,
  type ParentChild,
} from '@vidyalayaa/contracts';
import { api, useAuth } from '../../lib/auth';
import { Button } from '../../components/ui/button';
import { Badge, Empty, ErrorState, Loading } from '../../components/common';
import { ActionDialog } from '../../components/ActionDialog';
import { display, label } from '../../lib/utils';
import { schoolToday } from '../calendar/calendar-utils';
import { DateFilters, Metric } from './ParentInsightsControls';

export default function ParentAttendance({ child, base }: { child: ParentChild; base: string }) {
  const a = useAuth(),
    today = schoolToday(a.me?.school?.timezone);
  const [range, setRange] = useState({ from: today.slice(0, 7) + '-01', to: today }),
    [status, setStatus] = useState(''),
    [page, setPage] = useState(1),
    [correction, setCorrection] = useState<ParentAttendanceDay | null>(null);
  const params = new URLSearchParams({
    ...range,
    ...(status ? { status } : {}),
    page: String(page),
    page_size: '25',
  });
  const q = useQuery({
    queryKey: [a.school, 'parent-attendance', child.id, params.toString()],
    queryFn: () => api<ParentAttendanceResponse>(`${base}/attendance?${params}`),
    refetchInterval: 30000,
  });
  const s = q.data?.summary;
  return (
    <>
      <DateFilters
        range={range}
        today={today}
        academicStart={child.enrollment?.session_starts_on}
        onApply={(dates) => {
          setRange(dates);
          setPage(1);
        }}
      >
        <label className="text-sm">
          Attendance status
          <select
            className="input mt-1"
            aria-label="Attendance status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All days</option>
            {parentAttendanceStatuses.map((v) => (
              <option value={v} key={v}>
                {label(v)}
              </option>
            ))}
          </select>
        </label>
      </DateFilters>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorState error={q.error} retry={() => q.refetch()} />
      ) : (
        q.data && (
          <>
            <div
              className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4"
              aria-label="Attendance summary"
            >
              <Metric
                title="Total school days"
                value={s!.school_days}
                detail={`${q.data.range.from} to ${q.data.range.to}`}
              />
              <Metric
                title="Present days"
                value={s!.present_days}
                detail="Includes late and half days"
              />
              <Metric title="Absent days" value={s!.absent_days} detail="Recorded absences" />
              <Metric
                title="Attendance percentage"
                value={s!.attendance_percentage === null ? '—' : s!.attendance_percentage + '%'}
                detail={`${s!.finalized_days} finalized school days`}
              />
            </div>
            <p className="mb-4 text-sm text-stone-600">
              Attendance percentage = present days ÷ finalized days. {s!.unrecorded_days} school
              days not recorded · {s!.pending_days} pending · {s!.late_days} late · {s!.half_days}{' '}
              half days · {s!.excused_days} excused. Missing or pending records are excluded from
              the percentage and are not marked absent. Totals cover the date range, regardless of
              the status filter.
            </p>
            {q.data.uses_default_schedule && (
              <p className="notice mb-4">
                School days use the default Monday–Saturday schedule where your school has not
                configured attendance rules or timings. Recorded attendance and school holidays are
                respected.
              </p>
            )}
            {!q.data.data.length ? (
              <Empty
                title="No matching attendance days"
                description="Try another date range or attendance status."
              />
            ) : (
              <div className="overflow-x-auto rounded-2xl border border-line bg-white">
                <table className="w-full text-left text-sm">
                  <caption className="sr-only">Daily attendance for {child.first_name}</caption>
                  <thead>
                    <tr>
                      {[
                        'Date',
                        'Day',
                        'Attendance',
                        'Class & section',
                        'Arrival',
                        'Departure',
                        'Actions',
                      ].map((h) => (
                        <th className="whitespace-nowrap p-4 font-medium" key={h}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {q.data.data.map((day) => (
                      <tr className="border-t border-line" key={day.attendance_date}>
                        <td className="whitespace-nowrap p-4">{day.attendance_date}</td>
                        <td className="p-4">
                          {new Date(day.attendance_date + 'T12:00:00Z').toLocaleDateString(
                            'en-IN',
                            { weekday: 'short', timeZone: 'UTC' },
                          )}
                        </td>
                        <td className="p-4">
                          <Badge>{day.attendance_status}</Badge>
                          {day.day_note && (
                            <p className="mt-1 max-w-64 text-xs text-stone-500">{day.day_note}</p>
                          )}
                        </td>
                        <td className="whitespace-nowrap p-4">
                          {day.grade ? `Class ${day.grade} · ${day.section}` : '—'}
                        </td>
                        <td className="p-4">
                          {day.first_arrival_at
                            ? display(day.first_arrival_at, a.me?.school?.timezone)
                            : '—'}
                        </td>
                        <td className="p-4">
                          {day.last_departure_at
                            ? display(day.last_departure_at, a.me?.school?.timezone)
                            : '—'}
                        </td>
                        <td className="p-4">
                          {day.id &&
                          a.me?.school?.permissions.includes('attendance.correct_request') ? (
                            <Button size="sm" variant="outline" onClick={() => setCorrection(day)}>
                              Request correction
                            </Button>
                          ) : day.attendance_status === 'NOT_RECORDED' ? (
                            <span className="text-xs text-stone-500">Awaiting a school record</span>
                          ) : (
                            <span aria-label="No correction needed">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {!!q.data.total && (
              <div className="mt-4 flex items-center justify-between gap-3 text-sm">
                <span>
                  {q.data.total} days · Page {page}
                </span>
                <div className="flex gap-2">
                  <Button variant="outline" disabled={page === 1} onClick={() => setPage(page - 1)}>
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    disabled={page * 25 >= q.data!.total}
                    onClick={() => setPage(page + 1)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </>
        )
      )}
      {correction && (
        <ActionDialog
          open
          close={() => {
            setCorrection(null);
            q.refetch();
          }}
          title={`Request correction · ${correction.attendance_date}`}
          endpoint="/corrections"
          fields={[
            { key: 'daily_attendance_id', type: 'hidden', default: correction.id! },
            {
              key: 'requested_status',
              options: ['PRESENT', 'LATE', 'HALF_DAY', 'ABSENT', 'EXCUSED'],
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
