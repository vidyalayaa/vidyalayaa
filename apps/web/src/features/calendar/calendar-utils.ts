import type { CalendarEvent, CalendarKind, CalendarClass } from '@vidyalayaa/contracts';
export const kindColors: Record<CalendarKind, string> = {
  HOLIDAY: 'var(--accent-ink)',
  SCHOOL_EVENT: 'var(--info-ink)',
  EXAM_DAY: 'var(--violet-ink)',
  ACTIVITY: 'var(--danger-ink)',
  ANNOUNCEMENT: 'var(--pink-ink)',
  OTHER: 'var(--muted)',
  WEEKEND_OVERRIDE: 'var(--teal-ink)',
  SHORT_DAY: 'var(--warning-ink)',
};
export const months = Array.from({ length: 12 }, (_, month) =>
  new Intl.DateTimeFormat('en', { month: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2026, month, 1)),
  ),
);
export function dateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}
export function shiftDate(date: string, days: number) {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return dateKey(d);
}
export function prettyDate(date: string) {
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'long', timeZone: 'UTC' }).format(
    new Date(date + 'T12:00:00Z'),
  );
}
export function schoolToday(timeZone = 'Asia/Kolkata') {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
export function calendarDays(from: string, to: string) {
  const rows: string[] = [];
  for (let date = from; date <= to; date = shiftDate(date, 1)) rows.push(date);
  return rows;
}
export function eventsOn(events: CalendarEvent[], date: string) {
  return events.filter((e) => e.start_date <= date && e.end_date >= date);
}
export function groupClasses(classes: CalendarClass[]) {
  const groups = new Map<string, CalendarClass[]>();
  for (const c of classes) {
    const key = JSON.stringify([c.academic_session_id, c.grade]);
    groups.set(key, [...(groups.get(key) || []), c]);
  }
  return [...groups].sort(
    (a, b) =>
      Number(b[1][0].is_current) - Number(a[1][0].is_current) ||
      a[1][0].grade.localeCompare(b[1][0].grade, 'en', { numeric: true }) ||
      a[1][0].session_name.localeCompare(b[1][0].session_name),
  );
}
export function audienceLabel(event: CalendarEvent) {
  return event.audience === 'SCHOOL'
    ? 'Entire school'
    : event.targets
        .map((c) => `Class ${c.grade} · Section ${c.section} (${c.session_name})`)
        .join(', ');
}
