import { it, expect } from 'vitest';
import { defaultSchoolTimings, schoolTimingsSchema } from '@vidyalayaa/contracts';
import {
  generatePeriods,
  timetableRows,
  clock,
} from '../../apps/web/src/features/timetable/timetable-utils.js';
it('generates numbered lecture periods around breaks without overlapping or crossing midnight', () => {
  const periods = generatePeriods('08:00', 45, 3, [
    { label: 'Break', start_time: '09:30', end_time: '09:45' },
  ]);
  expect(periods.map((p) => [p.start_time, p.end_time])).toEqual([
    ['08:00', '08:45'],
    ['08:45', '09:30'],
    ['09:45', '10:30'],
  ]);
  expect(() => generatePeriods('23:30', 45, 2, [])).toThrow(/fit/);
  expect(() =>
    generatePeriods('08:00', 45, 3, [
      { label: 'A', start_time: '09:00', end_time: '09:30' },
      { label: 'B', start_time: '09:20', end_time: '09:40' },
    ]),
  ).toThrow(/overlap/);
});
it('validates school days, custom periods, lecture counts and break overlap through shared contracts', () => {
  expect(schoolTimingsSchema.safeParse(defaultSchoolTimings).success).toBe(true);
  for (const patch of [
    { days: [1, 1] },
    { lecture_count: 3 },
    { breaks: [{ label: 'Break', start_time: '08:20', end_time: '08:30' }] },
    { start_time: '22:00' },
    {
      periods: [{ number: 2, label: 'Wrong order', start_time: '09:00', end_time: '09:40' }],
      lecture_count: 1,
    },
  ])
    expect(schoolTimingsSchema.safeParse({ ...defaultSchoolTimings, ...patch }).success).toBe(
      false,
    );
});
it('retains unmatched legacy timings, including exact seconds, without duplicating configured rows', () => {
  const entry = { id: 'old', weekday: 7, starts_at: '14:00:30', ends_at: '14:40:30' };
  const rows = timetableRows(defaultSchoolTimings, [entry, entry] as never[]);
  expect(rows.filter((r) => r.kind === 'legacy')).toHaveLength(1);
  expect(rows.at(-1)?.start_time).toBe('14:00:30');
  expect(clock('08:00:00')).toBe('08:00');
  expect(clock('08:00:00.5')).toBe('08:00:00.5');
});
