import type { AttendanceCalendarDay, AttendanceCalendarState } from '@vidyalayaa/contracts';
import { dateKey, prettyDate, shiftDate } from '../calendar/calendar-utils';

export type Period = { from: string; to: string };
export type DayState = AttendanceCalendarState | 'MIXED';

export const states: Record<DayState, { label: string; short: string; color: string }> = {
  PRESENT: { label: 'Present', short: 'Present', color: 'present' },
  ABSENT: { label: 'Absent', short: 'Absent', color: 'absent' },
  HALF_DAY: { label: 'Half day', short: 'Half day', color: 'partial' },
  LATE: { label: 'Late', short: 'Late', color: 'partial' },
  EXCUSED: { label: 'Excused', short: 'Excused', color: 'excused' },
  PENDING: { label: 'Pending', short: 'Pending', color: 'pending' },
  NOT_RECORDED: { label: 'Unmarked', short: 'Unmarked', color: 'unmarked' },
  HOLIDAY: { label: 'Holiday', short: 'Holiday', color: 'off' },
  WEEKLY_OFF: { label: 'Weekly off', short: 'Off', color: 'off' },
  NOT_ENROLLED: { label: 'No scheduled attendance', short: '', color: 'unmarked' },
  FUTURE: { label: 'Future date', short: 'Future', color: 'future' },
  MIXED: { label: 'Mixed attendance', short: 'Mixed', color: 'mixed' },
};

const recordedStates = {
  PRESENT: 'present',
  ABSENT: 'absent',
  HALF_DAY: 'half_day',
  LATE: 'late',
  EXCUSED: 'excused',
  PENDING: 'pending',
  NOT_RECORDED: 'unmarked',
  HOLIDAY: 'holidays',
  WEEKLY_OFF: 'weekly_off',
} as const;

export function shiftMonth(date: string, months: number) {
  const first = new Date(date.slice(0, 7) + '-01T12:00:00Z');
  first.setUTCMonth(first.getUTCMonth() + months);
  return dateKey(first);
}

export function monthPeriod(month: string): Period {
  return { from: month.slice(0, 7) + '-01', to: shiftDate(shiftMonth(month, 1), -1) };
}

export function matchesState(
  date: string,
  today: string,
  day: AttendanceCalendarDay | undefined,
  state: AttendanceCalendarState,
) {
  if (date > today) return state === 'FUTURE';
  if (!day) return state === 'NOT_ENROLLED';
  return state in recordedStates && !!day[recordedStates[state as keyof typeof recordedStates]];
}

export function dayState(date: string, today: string, day?: AttendanceCalendarDay): DayState {
  if (date > today) return 'FUTURE';
  if (!day) return 'NOT_ENROLLED';
  const candidates = day.working
    ? (Object.keys(recordedStates) as (keyof typeof recordedStates)[]).filter(
        (key) => key !== 'HOLIDAY' && key !== 'WEEKLY_OFF' && day[recordedStates[key]],
      )
    : day.holidays
      ? (['HOLIDAY'] as const)
      : (['WEEKLY_OFF'] as const);
  return candidates.length === 1 ? candidates[0] : 'MIXED';
}

export function summarizeAttendance(days: AttendanceCalendarDay[]) {
  const result = {
    workingDays: 0,
    holidays: 0,
    present: 0,
    absent: 0,
    halfDays: 0,
    late: 0,
    excused: 0,
    unmarked: 0,
    pending: 0,
    usesDefault: false,
  };
  for (const day of days) {
    result.workingDays += Number(day.working > 0);
    result.holidays += Number(day.holidays > 0);
    result.present += day.present;
    result.absent += day.absent;
    result.halfDays += day.half_day;
    result.late += day.late;
    result.excused += day.excused;
    result.unmarked += day.unmarked;
    result.pending += day.pending;
    result.usesDefault ||= day.uses_default_schedule;
  }
  const attended = result.present + result.late + result.halfDays;
  const finalized = attended + result.absent + result.excused;
  return {
    ...result,
    percentage: finalized ? Math.round((attended * 1000) / finalized) / 10 : null,
  };
}

export function dayDescription(date: string, today: string, day?: AttendanceCalendarDay) {
  const state = states[dayState(date, today, day)].label;
  const details =
    day && day.working > 1
      ? [
          day.present && `${day.present} present`,
          day.absent && `${day.absent} absent`,
          day.half_day && `${day.half_day} half day`,
          day.late && `${day.late} late`,
          day.excused && `${day.excused} excused`,
          day.pending && `${day.pending} pending`,
          day.unmarked && `${day.unmarked} unmarked`,
        ]
          .filter(Boolean)
          .join(', ')
      : day?.holiday_names.join(', ');
  return [prettyDate(date), state, details].filter(Boolean).join(' · ');
}
