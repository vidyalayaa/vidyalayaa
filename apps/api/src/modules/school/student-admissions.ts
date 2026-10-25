import type { z } from 'zod';
import type { studentAdmissionSchema } from '@vidyalayaa/contracts';
import { audit, type Tx } from '../../lib/db.js';
import { ApiError, notFound } from '../../lib/errors.js';
import type { Actor } from '../../middleware/auth.js';
import { validateBusiness } from './resources.js';

async function insert(
  tx: Tx,
  sid: string,
  table: 'students' | 'parents' | 'enrollments' | 'student_parents',
  values: Record<string, unknown>,
) {
  const keys = Object.keys(values);
  return (
    await tx.query(
      `INSERT INTO ${table}(school_id,${keys.join(',')}) VALUES($1,${keys.map((_, i) => `$${i + 2}`).join(',')}) RETURNING *`,
      [sid, ...keys.map((k) => values[k])],
    )
  ).rows[0];
}
export async function saveStudentAdmission(
  tx: Tx,
  a: Actor,
  b: z.infer<typeof studentAdmissionSchema>,
) {
  for (const table of ['students', 'parents', 'student_parents', 'enrollments'])
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `${a.context.schoolId}:${table}`,
    ]);
  const classroom = (
    await tx.query(
      'SELECT c.id,c.academic_session_id FROM classes c JOIN academic_sessions ac ON ac.school_id=c.school_id AND ac.id=c.academic_session_id WHERE c.school_id=$1 AND c.id=$2 AND c.retired_at IS NULL AND ac.retired_at IS NULL FOR SHARE OF c,ac',
      [a.context.schoolId, b.enrollment.class_id],
    )
  ).rows[0];
  if (!classroom) throw notFound();
  if (
    b.student.status === 'ACTIVE' &&
    Number(
      (
        await tx.query("SELECT count(*) FROM students WHERE school_id=$1 AND status='ACTIVE'", [
          a.context.schoolId,
        ])
      ).rows[0].count,
    ) >= (a.limits.max_students ?? 0)
  )
    throw new ApiError(409, 'PLAN_LIMIT_REACHED', 'The student limit has been reached.');
  await validateBusiness(tx, a, 'students', b.student, false);
  const student = await insert(tx, a.context.schoolId, 'students', b.student);
  await audit(tx, a.context.schoolId, a.id, 'students.create', 'students', student.id);
  const enrollment = await insert(tx, a.context.schoolId, 'enrollments', {
    ...b.enrollment,
    student_id: student.id,
    academic_session_id: classroom.academic_session_id,
    status: 'ACTIVE',
  });
  await audit(tx, a.context.schoolId, a.id, 'enrollments.create', 'enrollments', enrollment.id);
  const parents = [],
    connections = [];
  for (const guardian of b.guardians) {
    let parent;
    if (guardian.parent_id) {
      parent = (
        await tx.query(
          "SELECT * FROM parents WHERE school_id=$1 AND id=$2 AND status='ACTIVE' FOR SHARE",
          [a.context.schoolId, guardian.parent_id],
        )
      ).rows[0];
      if (!parent) throw notFound();
    } else {
      const v = guardian.parent!;
      if (
        v.email &&
        (
          await tx.query('SELECT id FROM parents WHERE school_id=$1 AND email=$2::citext', [
            a.context.schoolId,
            v.email.trim(),
          ])
        ).rowCount
      )
        throw new ApiError(
          409,
          'PARENT_EXISTS',
          'A parent with this email already exists. Select the existing parent to link this child.',
        );
      parent = await insert(tx, a.context.schoolId, 'parents', {
        ...v,
        email: v.email?.trim() || null,
        status: 'ACTIVE',
      });
      await audit(tx, a.context.schoolId, a.id, 'parents.create', 'parents', parent.id);
    }
    const connection = await insert(tx, a.context.schoolId, 'student_parents', {
      student_id: student.id,
      parent_id: parent.id,
      relationship: guardian.relationship,
      is_primary_contact: guardian.is_primary_contact,
      can_receive_alerts: guardian.can_receive_alerts,
      status: 'ACTIVE',
    });
    await audit(
      tx,
      a.context.schoolId,
      a.id,
      'student_parents.create',
      'student_parents',
      connection.id,
    );
    parents.push(parent);
    connections.push(connection);
  }
  return { student, enrollment, parents, connections };
}
