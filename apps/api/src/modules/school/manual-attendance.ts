import type { z } from 'zod';
import type { manualSchema } from '@vidyalayaa/contracts';
import type { Tx } from '../../lib/db.js';
import { audit } from '../../lib/db.js';
import { ApiError } from '../../lib/errors.js';
import type { Actor } from '../../middleware/auth.js';
import { queue } from '../attendance/service.js';
import { assertStudent } from './resources.js';

export async function assertClassTeacher(tx: Tx, a: Actor, classId: string) {
  if (
    a.active!.role === 'teacher' &&
    !(
      await tx.query('SELECT app.is_class_teacher($1,$2) AS allowed', [a.context.schoolId, classId])
    ).rows[0]?.allowed
  )
    throw new ApiError(
      403,
      'CLASS_TEACHER_REQUIRED',
      'Only the designated Class Teacher can manage attendance for this class.',
    );
}

export async function attendanceEnrollment(
  tx: Tx,
  a: Actor,
  studentId: string,
  date: string,
  classId?: string,
) {
  await assertStudent(tx, a, studentId);
  const enrollment = (
    await tx.query(
      "SELECT * FROM enrollments WHERE school_id=$1 AND student_id=$2 AND status='ACTIVE' AND starts_on<=$3 AND (ends_on IS NULL OR ends_on>=$3) ORDER BY starts_on DESC LIMIT 1",
      [a.context.schoolId, studentId, date],
    )
  ).rows[0];
  if (!enrollment || (classId && enrollment.class_id !== classId))
    throw new ApiError(
      422,
      'ENROLLMENT_REQUIRED',
      'The student must be enrolled in this class on the selected date.',
    );
  await assertClassTeacher(tx, a, enrollment.class_id);
  return enrollment;
}

// Single and class-register writes must preserve the same evidence, enrollment,
// version and notification guarantees. The caller owns the atomic transaction.
export async function markManualAttendance(
  tx: Tx,
  a: Actor,
  b: z.infer<typeof manualSchema>,
  classId?: string,
) {
  const enrollment = await attendanceEnrollment(tx, a, b.student_id, b.date, classId);
  await tx.query(
    'INSERT INTO daily_attendance(school_id,student_id,attendance_date,class_id,academic_session_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(school_id,student_id,attendance_date) DO NOTHING',
    [a.context.schoolId, b.student_id, b.date, enrollment.class_id, enrollment.academic_session_id],
  );
  const day = (
    await tx.query(
      'SELECT * FROM daily_attendance WHERE school_id=$1 AND student_id=$2 AND attendance_date=$3 FOR UPDATE',
      [a.context.schoolId, b.student_id, b.date],
    )
  ).rows[0];
  if (day.class_id !== enrollment.class_id)
    throw new ApiError(
      409,
      'ENROLLMENT_CHANGED',
      'The attendance class differs from this enrollment. Review the record before changing it.',
    );
  if (b.expected_version !== undefined && day.version !== b.expected_version)
    throw new ApiError(409, 'VERSION_CONFLICT', 'Attendance changed. Refresh before saving.');
  if (day.source === 'NFC' && day.version > 0)
    throw new ApiError(
      409,
      'CORRECTION_REQUIRED',
      'Request a correction to change NFC attendance.',
    );
  const updated = (
    await tx.query(
      "UPDATE daily_attendance SET attendance_status=$2,source='MANUAL',manual_override=true,version=version+1 WHERE id=$1 RETURNING *",
      [day.id, b.status],
    )
  ).rows[0];
  await audit(
    tx,
    a.context.schoolId,
    a.id,
    `attendance.manual:${b.reason}`,
    'daily_attendance',
    day.id,
  );
  if (day.attendance_status !== b.status)
    await queue(
      tx,
      a.context.schoolId,
      b.student_id,
      'ATTENDANCE_CORRECTED',
      `ATTENDANCE_CORRECTED:${day.id}:${updated.version}`,
      {
        attendance_status: b.status,
        attendance_date: b.date,
        event_time: new Date().toISOString(),
      },
    );
  return updated;
}
