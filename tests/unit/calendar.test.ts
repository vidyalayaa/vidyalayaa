import { it, expect } from 'vitest';
import {
  calendarDays,
  shiftDate,
  eventsOn,
} from '../../apps/web/src/features/calendar/calendar-utils';
import type { CalendarEvent } from '@vidyalayaa/contracts';
it('keeps date-only calendar navigation correct across leap years and month/year boundaries', () => {
  expect(calendarDays('2028-01-01', '2028-12-31')).toHaveLength(366);
  expect(calendarDays('2027-01-01', '2027-12-31')).toHaveLength(365);
  expect(shiftDate('2028-02-28', 1)).toBe('2028-02-29');
  expect(shiftDate('2027-02-28', 1)).toBe('2027-03-01');
  expect(shiftDate('2027-01-01', -1)).toBe('2026-12-31');
});
it('places multi-day events on both endpoints and dates inside a cross-year range only', () => {
  const event = { id: 'one', start_date: '2027-12-30', end_date: '2028-01-02' } as CalendarEvent;
  for (const date of ['2027-12-30', '2027-12-31', '2028-01-01', '2028-01-02'])
    expect(eventsOn([event], date)).toEqual([event]);
  for (const date of ['2027-12-29', '2028-01-03']) expect(eventsOn([event], date)).toEqual([]);
});
