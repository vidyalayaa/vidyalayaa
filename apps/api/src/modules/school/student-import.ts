import { z } from 'zod';
import {
  studentAdmissionSchema,
  studentImportRowSchema,
  guardianImportFields,
  MAX_STUDENT_PARENTS,
  studentContactSchema,
} from '@vidyalayaa/contracts';
import type { Actor } from '../../middleware/auth.js';
import { audit, type Tx } from '../../lib/db.js';
import { ApiError } from '../../lib/errors.js';
import { saveStudentAdmission } from './student-admissions.js';
import { savePersonDetails } from './person-profile-details.js';

async function admissionForRow(tx: Tx, a: Actor, input: Record<string, unknown>) {
  const row = studentImportRowSchema.parse(input) as Record<string, unknown>;
  const classes = (
    await tx.query(
      `SELECT c.id FROM classes c JOIN academic_sessions ac ON ac.school_id=c.school_id AND ac.id=c.academic_session_id
     WHERE c.school_id=$1 AND c.grade=$2 AND c.section=$3 AND c.retired_at IS NULL AND ac.retired_at IS NULL
     AND (($4::text IS NULL AND ac.is_current) OR ac.name=$4)`,
      [a.context.schoolId, row.class_grade, row.class_section, row.academic_session || null],
    )
  ).rows;
  if (classes.length !== 1)
    throw new ApiError(
      422,
      'CLASS_NOT_UNIQUE',
      'Choose an existing, unique class grade, section and academic session. Blank academic_session uses the current session.',
    );
  const guardians = [];
  for (let i = 1; i <= MAX_STUDENT_PARENTS; i++) {
    const key = (field: string) => `parent_${i}_${field}`;
    if (!guardianImportFields.some((field) => row[key(field)] !== undefined)) continue;
    let details;
    if (row[key('mode')] === 'EXISTING') {
      if (!row[key('email')])
        throw new ApiError(
          422,
          'PARENT_EMAIL_REQUIRED',
          `Parent ${i}: EXISTING requires an email.`,
        );
      if (row[key('full_name')] || row[key('phone')])
        throw new ApiError(
          422,
          'EXISTING_PARENT_FIELDS',
          `Parent ${i}: leave full_name and phone blank for EXISTING; this import links existing parents without changing their details.`,
        );
      const matches = (
        await tx.query(
          "SELECT id FROM parents WHERE school_id=$1 AND email=$2::citext AND status='ACTIVE' FOR SHARE",
          [a.context.schoolId, row[key('email')]],
        )
      ).rows;
      if (matches.length !== 1)
        throw new ApiError(
          422,
          'PARENT_NOT_UNIQUE',
          `Parent ${i}: choose one existing active parent email in this school.`,
        );
      details = { parent_id: matches[0].id };
    } else {
      if (!row[key('full_name')])
        throw new ApiError(
          422,
          'PARENT_NAME_REQUIRED',
          `Parent ${i}: enter full_name for a NEW parent.`,
        );
      details = {
        parent: {
          full_name: row[key('full_name')],
          email: row[key('email')],
          phone: row[key('phone')],
        },
      };
    }
    guardians.push({
      ...details,
      relationship: row[key('relationship')] || 'GUARDIAN',
      is_primary_contact: row[key('is_primary_contact')] ?? i === 1,
      can_receive_alerts: row[key('can_receive_alerts')] ?? true,
    });
  }
  return studentAdmissionSchema.parse({
    student: Object.fromEntries(
      ['student_code', 'first_name', 'last_name', 'email', 'date_of_birth', 'gender', 'status']
        .filter((field) => row[field] !== undefined)
        .map((field) => [field, row[field]]),
    ),
    enrollment: {
      class_id: classes[0].id,
      roll_number: row.roll_number,
      starts_on: row.starts_on,
      ends_on: row.ends_on,
    },
    guardians,
  });
}

export async function importStudentAdmissions(
  tx: Tx,
  a: Actor,
  rows: Record<string, unknown>[],
  validateOnly: boolean,
) {
  // Match the single-admission lock order to protect quotas and concurrent imports.
  for (const table of ['students', 'parents', 'student_parents', 'enrollments'])
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `${a.context.schoolId}:${table}`,
    ]);
  const errors: { row: number; path: (string | number)[]; message: string }[] = [];
  await tx.query('SAVEPOINT student_import');
  for (let i = 0; i < rows.length; i++) {
    await tx.query('SAVEPOINT student_import_row');
    try {
      const row = rows[i];
      const saved = await saveStudentAdmission(tx, a, await admissionForRow(tx, a, row));
      if (row.contact_phone || row.address)
        await savePersonDetails(
          tx,
          a.context.schoolId,
          'student',
          saved.student.id,
          studentContactSchema.parse({ contact_phone: row.contact_phone, address: row.address }),
        );
    } catch (error) {
      await tx.query('ROLLBACK TO SAVEPOINT student_import_row');
      if (error instanceof z.ZodError)
        errors.push(
          ...error.issues.map((issue) => ({
            row: i + 1,
            path: issue.path,
            message: issue.message,
          })),
        );
      else
        errors.push({
          row: i + 1,
          path: [],
          message:
            error instanceof ApiError
              ? error.message
              : error instanceof Error && error.message === 'PROFILE_CODE_DUPLICATE'
                ? 'This admission number already exists in this school or import.'
                : 'This row conflicts with existing student, parent or enrollment records.',
        });
    }
    await tx.query('RELEASE SAVEPOINT student_import_row');
  }
  if (validateOnly || errors.length) await tx.query('ROLLBACK TO SAVEPOINT student_import');
  await tx.query('RELEASE SAVEPOINT student_import');
  if (errors.length)
    throw new ApiError(
      422,
      'IMPORT_VALIDATION_FAILED',
      'No records were imported. Correct every row and validate again.',
      errors,
    );
  if (!validateOnly) await audit(tx, a.context.schoolId, a.id, 'records.imported', 'students');
  return { validated: rows.length, imported: validateOnly ? 0 : rows.length };
}
