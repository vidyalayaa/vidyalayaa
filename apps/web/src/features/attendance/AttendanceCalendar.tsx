import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import {
  attendanceCalendarPeriodSchema,
  attendanceCalendarStates,
  type AttendanceCalendarDay,
  type AttendanceCalendarOptions,
  type AttendanceCalendarResponse,
  type AttendanceCalendarState,
} from '@vidyalayaa/contracts';
import { api, configured, useAuth } from '../../lib/auth';
import { Button } from '../../components/ui/button';
import { ErrorState, Loading, Panel } from '../../components/common';
import RecordSelect from '../../components/RecordSelect';
import {
  calendarDays,
  months,
  prettyDate,
  schoolToday,
  shiftDate,
} from '../calendar/calendar-utils';
import { AttendanceCalendarGrid, AttendanceLegend } from './AttendanceCalendarGrid';
import { AttendanceDayDialog } from './AttendanceDayDialog';
import {
  matchesState,
  monthPeriod,
  shiftMonth,
  states,
  summarizeAttendance,
  type Period,
} from './attendance-calendar-utils';
import './attendance-calendar.css';

const presets = [
  'This Month',
  'Last Month',
  'Last 3 Months',
  'Last 6 Months',
  'This Academic Year',
  'Custom Period',
] as const;
type Preset = (typeof presets)[number];
const calendarYear = (year: string) => ({ from: `${year}-01-01`, to: `${year}-12-31` });

function AttendanceSummary({
  title,
  days,
  period,
  personal,
  matching,
}: {
  title: string;
  days: AttendanceCalendarDay[];
  period: Period;
  personal: boolean;
  matching?: number;
}) {
  const totals = summarizeAttendance(days);
  const counts = [
    ['Working days', totals.workingDays],
    ['Present', totals.present],
    ['Absent', totals.absent],
    ['Half days', totals.halfDays],
    ['Holidays', totals.holidays],
    ['Attendance', totals.percentage === null ? '—' : `${totals.percentage}%`],
  ];
  return (
    <section className="attendance-summary" aria-label={title}>
      <h3>{title}</h3>
      <p className="text-xs text-stone-600">
        {prettyDate(period.from)} – {prettyDate(period.to)}
      </p>
      <dl>
        {counts.map(([name, value]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-stone-600">
        {totals.late} late · {totals.excused} excused · {totals.pending} pending · {totals.unmarked}{' '}
        unmarked
        {matching !== undefined && ` · ${matching} matching dates`}
        {!personal && ' · Present, absent and half days count student-days.'}
      </p>
    </section>
  );
}

export default function AttendanceCalendar({
  base = '/attendance/calendar',
  personal = false,
  onRegister,
  canCorrect,
}: {
  base?: string;
  personal?: boolean;
  onRegister?: (date: string, classId: string) => void;
  canCorrect?: (classId: string) => boolean;
}) {
  const a = useAuth();
  const localToday = schoolToday(a.me?.school?.timezone);
  const [month, setMonth] = useState(() => monthPeriod(localToday).from);
  const [period, setPeriod] = useState(() => monthPeriod(localToday));
  const [draft, setDraft] = useState(period);
  const [preset, setPreset] = useState<Preset | ''>('This Month');
  const [yearly, setYearly] = useState(false);
  const [session, setSession] = useState('');
  const [grade, setGrade] = useState('');
  const [section, setSection] = useState('');
  const [student, setStudent] = useState('');
  const [status, setStatus] = useState<AttendanceCalendarState | ''>('');
  const [date, setDate] = useState('');
  const [rangeError, setRangeError] = useState('');
  const fromInput = useRef<HTMLInputElement>(null);
  const enabled = configured && !!a.me?.school;
  const options = useQuery({
    queryKey: [a.school, 'attendance-calendar-options', base],
    queryFn: ({ signal }) => api<AttendanceCalendarOptions>(`${base}/options`, { signal }),
    enabled,
  });
  const sessions = options.data?.sessions || [];
  const academicYear = sessions.find((s) => s.starts_on <= localToday && s.ends_on >= localToday);
  const classes = (options.data?.classes || []).filter(
    (c) => !session || c.academic_session_id === session,
  );
  const grades = [...new Set(classes.map((c) => c.grade))].sort((x, y) =>
    x.localeCompare(y, 'en', { numeric: true }),
  );
  const sections = classes.filter((c) => c.grade === grade);
  const scope = new URLSearchParams({
    ...(session ? { academic_session_id: session } : {}),
    ...(grade ? { grade } : {}),
    ...(section ? { class_id: section } : {}),
  });
  const lookup = `${base}/students?${scope}`;
  if (student) scope.set('student_id', student);
  const filters = scope.toString();
  const year = month.slice(0, 4);
  const monthly = monthPeriod(month);
  const visible = yearly ? calendarYear(year) : monthly;
  const queryOptions = (range: Period) => {
    const params = new URLSearchParams(filters);
    params.set('from', range.from);
    params.set('to', range.to);
    return {
      queryKey: [a.school, 'attendance-calendar', base, params.toString()],
      queryFn: async ({ signal }: { signal: AbortSignal }): Promise<AttendanceCalendarResponse> => {
        const days: AttendanceCalendarDay[] = [];
        let today = localToday;
        // Some older academic sessions cover more than a calendar year. Read
        // them in bounded windows and omit future months from the summary.
        const end = range.to > localToday ? localToday : range.to;
        const lastDay = end < range.from ? range.from : end;
        for (let from = range.from; from <= lastDay; ) {
          const limit = shiftDate(from, 365);
          const to = limit < lastDay ? limit : lastDay;
          const query = new URLSearchParams(filters);
          query.set('from', from);
          query.set('to', to);
          const window = await api<AttendanceCalendarResponse>(`${base}?${query}`, { signal });
          today = window.today;
          days.push(...window.days);
          if (to === lastDay) break;
          from = shiftDate(to, 1);
        }
        return { today, days };
      },
      enabled,
      refetchInterval: 30_000,
    };
  };
  const grid = useQuery(queryOptions(visible));
  const monthlyData = useQuery(queryOptions(monthly));
  const selected = useQuery(queryOptions(period));
  const today = grid.data?.today || localToday;
  const days = new Map((grid.data?.days || []).map((day) => [day.date, day]));
  const selectedDays = new Map((selected.data?.days || []).map((day) => [day.date, day]));
  const matching =
    status && selected.data
      ? calendarDays(period.from, period.to).filter((d) =>
          matchesState(d, today, selectedDays.get(d), status),
        ).length
      : undefined;
  const thisYear = Number(localToday.slice(0, 4));
  const firstYear = Math.min(
    thisYear - 5,
    Number(year),
    ...sessions.map((s) => Number(s.starts_on.slice(0, 4))),
  );
  const lastYear = Math.max(thisYear + 5, Number(year));
  const years = Array.from({ length: lastYear - firstYear + 1 }, (_, i) => firstYear + i).reverse();

  function changePeriod(next: Period, quick: Preset | '' = '', anchor = next.to, academic = false) {
    if (!academic && !attendanceCalendarPeriodSchema.safeParse(next).success) {
      setRangeError('Choose a valid From–To period of up to 366 days.');
      return;
    }
    setRangeError('');
    setPreset(quick);
    setPeriod(next);
    setDraft(next);
    setMonth(monthPeriod(anchor).from);
    setDate('');
  }
  function changeMonth(next: string, showYear = yearly) {
    changePeriod(showYear ? calendarYear(next.slice(0, 4)) : monthPeriod(next), '', next);
  }
  function navigateCalendar(offset: number) {
    const next = shiftMonth(month, yearly ? offset * 12 : offset);
    const range = monthPeriod(next);
    if (!yearly && range.from <= period.to && range.to >= period.from) {
      setMonth(range.from);
      setDate('');
    } else {
      changeMonth(next);
    }
  }
  function changeSession(id: string) {
    setSession(id);
    setGrade('');
    setSection('');
    setStudent('');
    setDate('');
  }
  function quickFilter(quick: Preset) {
    switch (quick) {
      case 'This Month':
        changePeriod(monthPeriod(today), quick);
        break;
      case 'Last Month':
        changePeriod(monthPeriod(shiftMonth(today, -1)), quick);
        break;
      case 'Last 3 Months':
        changePeriod({ from: shiftMonth(today, -2), to: today }, quick);
        break;
      case 'Last 6 Months':
        changePeriod({ from: shiftMonth(today, -5), to: today }, quick);
        break;
      case 'This Academic Year':
        if (academicYear) {
          changeSession(academicYear.id);
          changePeriod(
            { from: academicYear.starts_on, to: academicYear.ends_on },
            quick,
            today,
            true,
          );
        }
        break;
      case 'Custom Period':
        setPreset(quick);
        fromInput.current?.focus();
        break;
    }
  }
  const failure = options.error
    ? options
    : grid.error
      ? grid
      : selected.error
        ? selected
        : monthlyData.error
          ? monthlyData
          : null;
  return (
    <Panel title="Attendance calendar" className="attendance-calendar">
      <div className="attendance-calendar-body">
        <form
          className="attendance-filters"
          aria-label="Attendance filters"
          onSubmit={(event) => {
            event.preventDefault();
            changePeriod(draft, 'Custom Period');
          }}
        >
          <label>
            From
            <input
              ref={fromInput}
              aria-label="From date"
              className="input"
              type="date"
              required
              value={draft.from}
              onChange={(e) => setDraft({ ...draft, from: e.target.value })}
            />
          </label>
          <label>
            To
            <input
              aria-label="To date"
              className="input"
              type="date"
              required
              value={draft.to}
              onChange={(e) => setDraft({ ...draft, to: e.target.value })}
            />
          </label>
          <label>
            Academic session
            <select
              className="input"
              value={session}
              onChange={(e) => {
                const chosen = sessions.find((s) => s.id === e.target.value);
                changeSession(e.target.value);
                if (chosen) {
                  const end = chosen.ends_on < today ? chosen.ends_on : today;
                  const anchor = end < chosen.starts_on ? chosen.starts_on : end;
                  changePeriod({ from: chosen.starts_on, to: chosen.ends_on }, '', anchor, true);
                }
              }}
            >
              <option value="">All sessions</option>
              {sessions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          {!personal && (
            <>
              <label>
                Class
                <select
                  className="input"
                  value={grade}
                  onChange={(e) => {
                    setGrade(e.target.value);
                    setSection('');
                    setStudent('');
                    setDate('');
                  }}
                >
                  <option value="">All classes</option>
                  {grades.map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
              </label>
              <label>
                Section
                <select
                  className="input"
                  value={section}
                  disabled={!grade}
                  onChange={(e) => {
                    setSection(e.target.value);
                    setStudent('');
                    setDate('');
                  }}
                >
                  <option value="">All sections</option>
                  {sections.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.section}
                      {!session
                        ? ` · ${sessions.find((s) => s.id === item.academic_session_id)?.name || ''}`
                        : ''}
                    </option>
                  ))}
                </select>
              </label>
              <div>
                <label className="field-label" htmlFor="attendance-calendar-student">
                  Student
                </label>
                <RecordSelect
                  key={lookup}
                  name="attendance-calendar-student"
                  endpoint={lookup}
                  value={student}
                  optional
                  label="student"
                  onChange={(id) => {
                    setStudent(id);
                    setDate('');
                  }}
                />
              </div>
            </>
          )}
          <label>
            Attendance status
            <select
              className="input"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value as AttendanceCalendarState | '');
                setDate('');
              }}
            >
              <option value="">All statuses</option>
              {attendanceCalendarStates.map((item) => (
                <option value={item} key={item}>
                  {states[item].label}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" variant="lime">
            Apply filters
          </Button>
        </form>
        {rangeError && (
          <p role="alert" className="field-error mt-2">
            {rangeError}
          </p>
        )}
        <div className="attendance-presets" aria-label="Quick date filters">
          {presets.map((quick) => (
            <Button
              key={quick}
              type="button"
              size="sm"
              variant={preset === quick ? 'lime' : 'outline'}
              aria-pressed={preset === quick}
              disabled={quick === 'This Academic Year' && !academicYear}
              onClick={() => quickFilter(quick)}
            >
              {quick}
            </Button>
          ))}
        </div>
        <div className="attendance-calendar-toolbar">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="icon"
              variant="outline"
              aria-label={yearly ? 'Previous year' : 'Previous month'}
              onClick={() => navigateCalendar(-1)}
            >
              <ChevronLeft size={18} />
            </Button>
            <h3 aria-live="polite">
              {yearly ? year : `${months[Number(month.slice(5, 7)) - 1]} ${year}`}
            </h3>
            <Button
              size="icon"
              variant="outline"
              aria-label={yearly ? 'Next year' : 'Next month'}
              onClick={() => navigateCalendar(1)}
            >
              <ChevronRight size={18} />
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Calendar year"
              className="input w-auto"
              value={year}
              onChange={(e) => changeMonth(e.target.value + month.slice(4))}
            >
              {years.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
            <Button
              variant={yearly ? 'lime' : 'outline'}
              aria-pressed={yearly}
              onClick={() => {
                setYearly(!yearly);
                changeMonth(month, !yearly);
              }}
            >
              Yearly heatmap
            </Button>
          </div>
        </div>
        {failure ? (
          <ErrorState error={failure.error!} retry={() => failure.refetch()} />
        ) : grid.isLoading ? (
          <Loading />
        ) : (
          <>
            <AttendanceCalendarGrid
              range={visible}
              period={period}
              today={today}
              days={days}
              status={status}
              yearly={yearly}
              onSelect={setDate}
            />
            <AttendanceLegend yearly={yearly} />
          </>
        )}
        {(selected.isLoading || monthlyData.isLoading) && !failure && <Loading />}
        {selected.data && monthlyData.data && !failure && (
          <>
            <div className="attendance-summaries">
              <AttendanceSummary
                title="Monthly summary"
                days={monthlyData.data.days}
                period={monthly}
                personal={personal || !!student}
              />
              <AttendanceSummary
                title="Selected period"
                days={selected.data.days}
                period={period}
                personal={personal || !!student}
                matching={matching}
              />
            </div>
            <p className="mt-3 text-xs text-stone-600">
              Attendance counts present, late and half-day records against finalized working
              attendance. Holidays, weekly offs, pending and unmarked days are excluded.
              {(selected.data.days.some((d) => d.uses_default_schedule) ||
                monthlyData.data.days.some((d) => d.uses_default_schedule)) &&
                ' Where no schedule is configured, Monday–Saturday is used.'}
            </p>
          </>
        )}
      </div>
      {date && (
        <AttendanceDayDialog
          key={date}
          base={base}
          filters={filters}
          date={date}
          day={days.get(date)}
          today={today}
          status={status}
          onClose={() => setDate('')}
          canCorrect={canCorrect}
          onRegister={onRegister && (() => onRegister(date, section))}
        />
      )}
    </Panel>
  );
}
