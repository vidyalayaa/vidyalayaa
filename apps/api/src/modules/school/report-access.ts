import type { Actor } from '../../middleware/auth.js';
import type { Tx } from '../../lib/db.js';
import { notFound } from '../../lib/errors.js';
import { assertClass, assertStudent } from './resources.js';

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
