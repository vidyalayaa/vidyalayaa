import type { PersonKind, StaffDetails, StudentContact } from '@vidyalayaa/contracts';
import type { Tx } from '../../lib/db.js';

export async function savePersonDetails(
  tx: Tx,
  school: string,
  kind: PersonKind,
  id: string,
  details: StaffDetails | StudentContact,
) {
  const column = kind === 'student' ? 'student_id' : 'staff_id';
  await tx.query(
    `INSERT INTO school_person_details(school_id,${column},details) VALUES($1,$2,$3)
      ON CONFLICT(school_id,${column}) DO UPDATE SET details=EXCLUDED.details`,
    [school, id, details],
  );
}
