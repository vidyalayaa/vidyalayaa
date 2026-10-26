import { it, expect } from 'vitest';
import { defaultSchoolTimings, schoolTimingsSchema } from '@vidyalayaa/contracts';
import {
  generatePeriods,
  timetableRows,
  clock,
  localSchoolTime,
  lectureIsRunning,
} from '../../apps/web/src/features/timetable/timetable-utils.js';
it('highlights actual start-inclusive/end-exclusive lecture times in the school timezone', () => {
  const entry = { weekday: 1, starts_at: '08:00:00', ends_at: '08:45:00' };
  const active = (date: string, zone = 'Asia/Kolkata') =>
    lectureIsRunning(entry, localSchoolTime(new Date(date), zone));
  expect(active('2026-10-26T02:29:59.999Z')).toBe(false);
  expect(active('2026-10-26T02:30:00Z')).toBe(true);
  expect(active('2026-10-26T03:14:59.999Z')).toBe(true);
  expect(active('2026-10-26T03:15:00Z')).toBe(false);
  expect(active('2026-10-27T02:30:00Z')).toBe(false);
  expect(active('2026-10-26T02:30:00Z', 'UTC')).toBe(false);
  expect(lectureIsRunning(entry, null)).toBe(false);
});
it('handles exact legacy seconds, day rollover, fractional offsets, breaks and DST', () => {
  const fractional = { weekday: 1, starts_at: '08:00:00.500', ends_at: '08:00:30.250' };
  expect(
    lectureIsRunning(
      fractional,
      localSchoolTime(new Date('2026-10-26T02:30:00.499Z'), 'Asia/Kolkata'),
    ),
  ).toBe(false);
  expect(
    lectureIsRunning(
      fractional,
      localSchoolTime(new Date('2026-10-26T02:30:00.500Z'), 'Asia/Kolkata'),
    ),
  ).toBe(true);
  expect(
    lectureIsRunning(
      fractional,
      localSchoolTime(new Date('2026-10-26T02:30:30.250Z'), 'Asia/Kolkata'),
    ),
  ).toBe(false);
  const slots = [
    { weekday: 1, starts_at: '08:00', ends_at: '09:30' },
    { weekday: 1, starts_at: '09:45', ends_at: '10:30' },
  ];
  expect(
    slots.some((e) =>
      lectureIsRunning(e, localSchoolTime(new Date('2026-10-26T04:00:00Z'), 'Asia/Kolkata')),
    ),
  ).toBe(false);
  expect(
    slots.some((e) =>
      lectureIsRunning(e, localSchoolTime(new Date('2026-10-26T04:15:00Z'), 'Asia/Kolkata')),
    ),
  ).toBe(true);
  expect(localSchoolTime(new Date('2026-10-26T12:30:00Z'), 'Pacific/Auckland')).toMatchObject({
    weekday: 2,
    time: '01:30:00',
  });
  expect(localSchoolTime(new Date('2026-10-25T20:15:00Z'), 'Asia/Kathmandu')).toMatchObject({
    weekday: 1,
    time: '02:00:00',
  });
  const repeated = { weekday: 7, starts_at: '01:15', ends_at: '01:45' };
  for (const instant of ['2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z'])
    expect(lectureIsRunning(repeated, localSchoolTime(new Date(instant), 'America/New_York'))).toBe(
      true,
    );
});
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
