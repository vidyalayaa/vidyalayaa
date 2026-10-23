import { defaultSchoolTimings } from '@vidyalayaa/contracts';
import { generatePeriods } from '../../../apps/web/src/features/timetable/timetable-utils';
import type { PlatformApp } from './platform-app';
import { expect } from '@playwright/test';
export const timingTemplate = {
  ...defaultSchoolTimings,
  lecture_duration: 45,
  lecture_count: 3,
  breaks: [{ label: 'Morning break', start_time: '09:30', end_time: '09:45' }],
  periods: generatePeriods('08:00', 45, 3, [
    { label: 'Morning break', start_time: '09:30', end_time: '09:45' },
  ]),
};
export function timetableAdmin(p: PlatformApp) {
  return (path: string, method = 'GET', body?: unknown) =>
    p.request(path, method, body, p.records.admin, p.records.schoolA);
}
export async function saveTimingTemplate(p: PlatformApp) {
  const call = timetableAdmin(p),
    before = await call('/timetable/settings');
  const r = await call('/timetable/settings', 'PUT', {
    expected_version: before.body.version,
    settings: timingTemplate,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}
export async function timetableSection(p: PlatformApp, suffix: string, useOriginalTeacher = false) {
  const call = timetableAdmin(p),
    f = p.records;
  const teacher = useOriginalTeacher
    ? f.teacherId
    : (
        await call('/resources/teachers', 'POST', {
          staff_code: 'TT_' + suffix,
          full_name: 'Timetable teacher ' + suffix,
        })
      ).body.id;
  const c = await call('/resources/classes', 'POST', {
    academic_session_id: f.session,
    grade: '9',
    section: 'TT_' + suffix,
    class_teacher_id: teacher,
  });
  expect(c.status).toBe(201);
  expect(
    (
      await call('/resources/teacher_class_assignments', 'POST', {
        teacher_id: teacher,
        class_id: c.body.id,
        subject_id: f.subject,
        starts_on: '2026-01-01',
      })
    ).status,
  ).toBe(201);
  return { classId: c.body.id as string, teacherId: teacher as string };
}
