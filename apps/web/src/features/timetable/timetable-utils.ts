import { schoolClock, type SchoolTimings, type TimetableEntry } from '@vidyalayaa/contracts';
export const weekdays = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];
const clockFormats = new Map<string, Intl.DateTimeFormat>();
export interface LocalSchoolTime {
  weekday: number;
  seconds: number;
  time: string;
}
export function localSchoolTime(now: Date, timezone: string): LocalSchoolTime {
  let formatter = clockFormats.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      fractionalSecondDigits: 3,
    });
    clockFormats.set(timezone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(now).map((p) => [p.type, p.value]));
  const day = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday) + 1;
  return {
    weekday: day,
    seconds:
      Number(parts.hour) * 3600 +
      Number(parts.minute) * 60 +
      Number(parts.second) +
      Number(parts.fractionalSecond || 0) / 1000,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
  };
}
export function lectureIsRunning(
  entry: Pick<TimetableEntry, 'weekday' | 'starts_at' | 'ends_at'>,
  now: LocalSchoolTime | null,
) {
  return (
    !!now &&
    entry.weekday === now.weekday &&
    seconds(entry.starts_at) <= now.seconds &&
    now.seconds < seconds(entry.ends_at)
  );
}
export function clock(v: string) {
  return Number(v.split(':')[2] || 0) ? v : v.slice(0, 5);
}
export function seconds(v: string) {
  const [h, m, s = 0] = v.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}
export function generatePeriods(
  start: string,
  duration: number,
  count: number,
  breaks: SchoolTimings['breaks'],
) {
  schoolClock.parse(start);
  if (
    !Number.isInteger(duration) ||
    duration < 5 ||
    duration > 180 ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > 16
  )
    throw new Error('Choose 1–16 lectures and a duration of 5–180 minutes.');
  const blocks = breaks
    .map((b) => {
      schoolClock.parse(b.start_time);
      schoolClock.parse(b.end_time);
      if (b.end_time <= b.start_time) throw new Error('Break end time must follow its start time.');
      return { start: seconds(b.start_time) / 60, end: seconds(b.end_time) / 60 };
    })
    .sort((a, b) => a.start - b.start);
  if (blocks.some((b, i) => i > 0 && b.start < blocks[i - 1].end))
    throw new Error('Breaks cannot overlap.');
  let next = seconds(start) / 60;
  const format = (n: number) =>
    `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
  return Array.from({ length: count }, (_, i) => {
    for (const b of blocks) if (next < b.end && next + duration > b.start) next = b.end;
    if (next + duration >= 1440)
      throw new Error('These lectures do not fit in one school day. Reduce the count or duration.');
    const p = {
      number: i + 1,
      label: `Lecture ${i + 1}`,
      start_time: format(next),
      end_time: format(next + duration),
    };
    next += duration;
    return p;
  });
}
export interface TimetableRow {
  key: string;
  label: string;
  start_time: string;
  end_time: string;
  kind: 'period' | 'break' | 'legacy';
  number?: number;
}
export function timetableRows(settings: SchoolTimings, entries: TimetableEntry[]) {
  const rows: TimetableRow[] = [
    ...settings.periods.map((p) => ({
      ...p,
      key: `${p.start_time}/${p.end_time}`,
      kind: 'period' as const,
    })),
    ...settings.breaks.map((b, i) => ({ ...b, key: 'break-' + i, kind: 'break' as const })),
  ];
  for (const e of entries) {
    const start_time = clock(e.starts_at),
      end_time = clock(e.ends_at);
    if (
      !rows.some(
        (r) => r.kind !== 'break' && r.start_time === start_time && r.end_time === end_time,
      )
    )
      rows.push({
        key: `legacy-${start_time}/${end_time}`,
        label: 'Existing lecture',
        start_time,
        end_time,
        kind: 'legacy',
      });
  }
  return rows.sort(
    (a, b) =>
      seconds(a.start_time) - seconds(b.start_time) || seconds(a.end_time) - seconds(b.end_time),
  );
}
export const overlaps = (entry: TimetableEntry, row: TimetableRow) =>
  seconds(entry.starts_at) < seconds(row.end_time) &&
  seconds(entry.ends_at) > seconds(row.start_time);
