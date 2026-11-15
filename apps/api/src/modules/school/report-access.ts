import type { Actor } from '../../middleware/auth.js';
import type { Tx } from '../../lib/db.js';
import type { reportSchema } from '@vidyalayaa/contracts';
import type { z } from 'zod';
import { ApiError, notFound } from '../../lib/errors.js';
import { assertClass, assertStudent, resourceScope } from './resources.js';

export async function validateReportFilters(
  tx: Tx,
  actor: Actor,
  report: z.infer<typeof reportSchema>,
) {
  const scope = [actor.context.schoolId, actor.id];
  if (report.academic_session_id) {
    const session = await tx.query(
      'SELECT t.id FROM academic_sessions t WHERE t.school_id=$1 AND t.id=$3 AND $2::uuid IS NOT NULL',
      [...scope, report.academic_session_id],
    );
    if (!session.rowCount) throw notFound();
    if (report.class_id) {
      const matchingClass = await tx.query(
        'SELECT 1 FROM classes WHERE school_id=$1 AND id=$2 AND academic_session_id=$3',
        [actor.context.schoolId, report.class_id, report.academic_session_id],
      );
      if (!matchingClass.rowCount)
        throw new ApiError(
          422,
          'REPORT_FILTER_MISMATCH',
          'Choose a class in the selected academic session.',
        );
    }
  }
  if (report.exam_id) {
    const {
      rows: [exam],
    } = await tx.query(
      `SELECT t.class_id,t.assessment_kind,t.subject_id,c.academic_session_id FROM exams t
       JOIN classes c ON c.school_id=t.school_id AND c.id=t.class_id
       WHERE t.school_id=$1 AND t.id=$3 AND ${resourceScope('exams', actor, '$2')}`,
      [...scope, report.exam_id],
    );
    if (!exam) throw notFound();
    if (
      (report.class_id && report.class_id !== exam.class_id) ||
      (report.academic_session_id && report.academic_session_id !== exam.academic_session_id) ||
      (report.subject_id &&
        exam.assessment_kind === 'SUBJECT_TEST' &&
        report.subject_id !== exam.subject_id)
    )
      throw new ApiError(
        422,
        'REPORT_FILTER_MISMATCH',
        'Choose an exam and subject that match the selected class and academic session.',
      );
  }
  if (report.subject_id) {
    const subject = await tx.query(
      `SELECT t.id FROM subjects t WHERE t.school_id=$1 AND t.id=$3 AND ${resourceScope('subjects', actor, '$2')}`,
      [...scope, report.subject_id],
    );
    if (!subject.rowCount) throw notFound();
  }
}

export async function authorizeReport(tx: Tx, actor: Actor, report: Record<string, any>) {
  const needed =
    report.kind === 'FEES'
      ? 'fees.read'
      : report.kind === 'ACADEMIC'
        ? 'marks.read'
        : 'attendance.read';
  if (
    !actor.active?.permissions.includes('reports.export') ||
    !actor.active.permissions.includes(needed)
  )
    throw notFound();
  if (report.parameters?.format === 'CSV' && !actor.features.advanced_reporting) throw notFound();
  const school = (
    await tx.query(
      'SELECT access_version,app.report_scope_fingerprint($2) AS fingerprint FROM schools WHERE id=$1',
      [actor.context.schoolId, actor.id],
    )
  ).rows[0];
  if (
    !school ||
    !report.authorization_version ||
    String(school.access_version) !== String(report.authorization_version) ||
    report.authorization_role !== actor.active.role ||
    !school.fingerprint ||
    report.authorization_scope !== school.fingerprint
  )
    throw notFound();
  if (['parent', 'student'].includes(actor.active.role) && !report.student_id) throw notFound();
  if (report.student_id) await assertStudent(tx, actor, report.student_id);
  if (report.class_id) await assertClass(tx, actor, report.class_id);
}
