import { useState, type KeyboardEvent } from 'react';
import type { AttendanceCalendarDay, AttendanceCalendarState } from '@vidyalayaa/contracts';
import { calendarDays, months, shiftDate } from '../calendar/calendar-utils';
import {
  dayDescription,
  dayState,
  matchesState,
  states,
  summarizeAttendance,
  type Period,
} from './attendance-calendar-utils';

const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const weekday = (day: string) => new Date(day + 'T12:00:00Z').getUTCDay();
const heat = ['zero', 'low', 'medium', 'high', 'full'] as const;

function heatLevel(day?: AttendanceCalendarDay) {
  const percentage = day && summarizeAttendance([day]).percentage;
  if (percentage == null) return undefined;
  return heat[percentage === 0 ? 0 : Math.ceil(percentage / 25)];
}

export function AttendanceCalendarGrid({
  range,
  period,
  today,
  days,
  status,
  yearly,
  onSelect,
}: {
  range: Period;
  period: Period;
  today: string;
  days: Map<string, AttendanceCalendarDay>;
  status: AttendanceCalendarState | '';
  yearly: boolean;
  onSelect: (date: string) => void;
}) {
  const dates = calendarDays(range.from, range.to);
  const offset = weekday(range.from);
  const [focused, setFocused] = useState('');
  const tabStop =
    focused >= range.from && focused <= range.to
      ? focused
      : today >= range.from && today <= range.to
        ? today
        : range.from;
  const year = range.from.slice(0, 4);
  const weeks = Math.ceil((dates.length + offset) / 7);
  function move(event: KeyboardEvent<HTMLButtonElement>, date: string) {
    const steps: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
    };
    const heatSteps: Record<string, number> = {
      ArrowLeft: -7,
      ArrowRight: 7,
      ArrowUp: -1,
      ArrowDown: 1,
    };
    const delta = (yearly ? heatSteps : steps)[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    const next = shiftDate(date, delta);
    event.currentTarget
      .closest('[data-attendance-grid]')
      ?.querySelector<HTMLButtonElement>(`[data-date="${next}"]`)
      ?.focus();
  }
  function cell(date: string, i: number) {
    const day = days.get(date);
    const state = dayState(date, today, day);
    const tone = states[state];
    const description = dayDescription(date, today, day);
    const percentage = yearly && day ? summarizeAttendance([day]).percentage : null;
    const shaded = yearly && date <= today ? heatLevel(day) : undefined;
    const outside = date < period.from || date > period.to;
    const unmatched = !!status && !matchesState(date, today, day, status);
    return (
      <button
        type="button"
        key={date}
        className={`attendance-day ${yearly ? 'attendance-heat-day' : ''}`}
        data-date={date}
        data-tone={shaded || tone.color}
        data-dimmed={outside || unmatched ? '' : undefined}
        aria-current={date === today ? 'date' : undefined}
        tabIndex={date === tabStop ? 0 : -1}
        aria-label={
          percentage === null ? description : `${description} · ${percentage}% attendance`
        }
        title={percentage === null ? description : `${description} · ${percentage}% attendance`}
        style={
          yearly
            ? { gridColumn: Math.floor((offset + i) / 7) + 2, gridRow: weekday(date) + 2 }
            : undefined
        }
        onKeyDown={(event) => move(event, date)}
        onFocus={() => setFocused(date)}
        onClick={() => onSelect(date)}
      >
        {!yearly && (
          <>
            <span className="attendance-day-number">{Number(date.slice(8))}</span>
            <span className="attendance-day-label">{tone.short}</span>
          </>
        )}
      </button>
    );
  }
  return yearly ? (
    <div
      className="attendance-heat-scroll"
      tabIndex={0}
      role="region"
      aria-label={`${year} attendance heatmap`}
    >
      <div
        className="attendance-heat"
        data-attendance-grid
        style={{ gridTemplateColumns: `2.75rem repeat(${weeks}, 1rem)` }}
      >
        {months.map((month, i) => {
          const first = `${year}-${String(i + 1).padStart(2, '0')}-01`;
          return (
            <span
              key={month}
              className="attendance-heat-month"
              style={{
                gridColumn: Math.floor((offset + dates.indexOf(first)) / 7) + 2,
                gridRow: 1,
              }}
            >
              {month.slice(0, 3)}
            </span>
          );
        })}
        {[1, 3, 5].map((day) => (
          <span
            className="attendance-heat-weekday"
            key={day}
            style={{ gridColumn: 1, gridRow: day + 2 }}
          >
            {weekdays[day]}
          </span>
        ))}
        {dates.map(cell)}
      </div>
    </div>
  ) : (
    <div className="attendance-month" data-attendance-grid>
      {weekdays.map((day) => (
        <span className="attendance-weekday" key={day}>
          {day}
        </span>
      ))}
      {Array.from({ length: offset }, (_, i) => (
        <span key={i} aria-hidden="true" />
      ))}
      {dates.map(cell)}
    </div>
  );
}

export function AttendanceLegend({ yearly }: { yearly: boolean }) {
  const entries: [string, string][] = yearly
    ? [
        ['zero', '0%'],
        ['low', '1–25%'],
        ['medium', '26–50%'],
        ['high', '51–75%'],
        ['full', '76–100%'],
        ['off', 'Holiday or weekly off'],
        ['unmarked', 'No finalized attendance'],
      ]
    : [
        ['present', 'Present'],
        ['absent', 'Absent'],
        ['partial', 'Late or half day'],
        ['excused', 'Excused'],
        ['pending', 'Pending'],
        ['off', 'Holiday or weekly off'],
        ['unmarked', 'Unmarked or future'],
        ['mixed', 'Mixed'],
      ];
  return (
    <ul className="attendance-legend" aria-label="Calendar legend">
      {entries.map(([tone, name]) => (
        <li key={tone}>
          <span className="attendance-swatch" data-tone={tone} aria-hidden="true" />
          {name}
        </li>
      ))}
    </ul>
  );
}
