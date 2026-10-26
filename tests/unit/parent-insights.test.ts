import { it, expect } from 'vitest';
import {
  attendanceSummary,
  resultCharts,
} from '../../apps/api/src/modules/school/parent-insights.js';
import type { ParentAttendanceDay, ParentResultRecord } from '@vidyalayaa/contracts';
it('normalizes different maximum scores with weighted totals instead of averaging percentages', () => {
  const row = {
    id: '1',
    exam_id: 'exam-1',
    subject_id: 'subject',
    examination: 'Exam one',
    assessment_kind: 'SUBJECT_TEST',
    exam_type: 'UNIT',
    exam_date: '2026-10-01',
    result_date: '2026-10-01',
    subject: 'Maths',
    score: 90,
    max_score: 100,
    remarks: null,
  } satisfies ParentResultRecord;
  const data = [
    row,
    {
      ...row,
      id: '2',
      exam_id: 'exam-2',
      examination: 'Exam two',
      score: 5,
      max_score: 10,
      exam_date: '2026-10-02',
    },
  ];
  expect(resultCharts(data).summary.percentage).toBe(86.4);
  expect(resultCharts(data).subject_chart[0].percentage).toBe(86.4);
  expect(resultCharts(data).exam_chart.map((e) => e.percentage)).toEqual([90, 50]);
  expect(resultCharts([]).summary.percentage).toBeNull();
  const decimals = resultCharts([
    { ...row, score: 0.1, max_score: 0.2 },
    { ...row, id: 'decimal', score: 0.2, max_score: 0.4 },
  ]);
  expect(decimals.summary).toMatchObject({ score: 0.3, maximum: 0.6, percentage: 50 });
  expect(decimals.subject_chart[0].score).toBe(0.3);
});
it('excludes unrecorded, pending, holidays and weekly offs from finalized percentages without inventing absences', () => {
  const day = {
    id: null,
    attendance_date: '2026-10-01',
    attendance_status: 'PRESENT',
    school_day: true,
    day_note: null,
    schedule_source: 'TIMETABLE',
    first_arrival_at: null,
    last_departure_at: null,
    grade: '8',
    section: 'A',
  } satisfies ParentAttendanceDay;
  const data = [
    day,
    { ...day, attendance_status: 'ABSENT' },
    { ...day, attendance_status: 'NOT_RECORDED' },
    { ...day, attendance_status: 'PENDING' },
    { ...day, attendance_status: 'HOLIDAY', school_day: false },
    { ...day, attendance_status: 'WEEKLY_OFF', school_day: false },
  ] as ParentAttendanceDay[];
  expect(attendanceSummary(data)).toMatchObject({
    school_days: 4,
    present_days: 1,
    absent_days: 1,
    pending_days: 1,
    unrecorded_days: 1,
    finalized_days: 2,
    attendance_percentage: 50,
  });
  expect(attendanceSummary([]).attendance_percentage).toBeNull();
});
