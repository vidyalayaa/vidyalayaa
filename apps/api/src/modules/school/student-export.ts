import {
  guardianImportFields,
  studentImportFields,
  MAX_STUDENT_PARENTS,
} from '@vidyalayaa/contracts';
import type { Tx } from '../../lib/db.js';

export function csvCell(value: unknown) {
  const text = value === null || value === undefined ? '' : String(value);
  // Spreadsheet applications must not interpret untrusted names/codes as formulas.
  return '"' + (/^[\s\uFEFF]*[=+@-]/.test(text) ? "'" + text : text).replaceAll('"', '""') + '"';
}

export async function* studentExportRows(tx: Tx, school: string, search: string, session?: string) {
  const n = Number(
    (
      await tx.query(
        'SELECT COALESCE(max(n),0) AS n FROM (SELECT count(*) AS n FROM student_parents WHERE school_id=$1 GROUP BY student_id) families',
        [school],
      )
    ).rows[0].n,
  );
  const columns = [
    ...studentImportFields,
    'enrollment_status',
    ...Array.from({ length: Math.max(MAX_STUDENT_PARENTS, n) }, (_, i) => [
      ...guardianImportFields.map((field) => `parent_${i + 1}_${field}`),
      `parent_${i + 1}_status`,
      `parent_${i + 1}_link_status`,
    ]).flat(),
  ];
  yield '\uFEFF' + columns.map(csvCell).join(',') + '\r\n';
  let cursor: string | null = null;
  for (;;) {
    const rows: Record<string, any>[] = (
      await tx.query(
        `SELECT s.id,s.student_code,s.first_name,s.last_name,s.email::text,to_char(s.date_of_birth,'YYYY-MM-DD') AS date_of_birth,s.gender,s.status,
        d.details->>'contact_phone' AS contact_phone,d.details->>'address' AS address,
        selected.academic_session,selected.class_grade,selected.class_section,selected.roll_number,selected.starts_on,selected.ends_on,selected.enrollment_status,
        COALESCE(family.guardians,'[]'::jsonb) AS guardians
       FROM students s JOIN schools sc ON sc.id=s.school_id
       LEFT JOIN school_person_details d ON d.school_id=s.school_id AND d.student_id=s.id
       LEFT JOIN LATERAL(
         SELECT ac.name AS academic_session,c.grade AS class_grade,c.section AS class_section,e.roll_number,
           to_char(e.starts_on,'YYYY-MM-DD') AS starts_on,to_char(e.ends_on,'YYYY-MM-DD') AS ends_on,e.status AS enrollment_status
         FROM enrollments e JOIN classes c ON c.school_id=e.school_id AND c.id=e.class_id
         JOIN academic_sessions ac ON ac.school_id=c.school_id AND ac.id=c.academic_session_id
         WHERE e.school_id=s.school_id AND e.student_id=s.id AND ($4::uuid IS NULL OR e.academic_session_id=$4)
         ORDER BY (e.status='ACTIVE' AND c.retired_at IS NULL AND e.starts_on<=(now() AT TIME ZONE sc.timezone)::date
           AND (e.ends_on IS NULL OR e.ends_on>=(now() AT TIME ZONE sc.timezone)::date)) DESC,e.starts_on DESC,e.id LIMIT 1
       ) selected ON true
       LEFT JOIN LATERAL(
         SELECT jsonb_agg(jsonb_build_object('mode','EXISTING','full_name',p.full_name,'email',p.email::text,'phone',p.phone,
           'relationship',sp.relationship,'is_primary_contact',sp.is_primary_contact,'can_receive_alerts',sp.can_receive_alerts,
           'status',p.status,'link_status',sp.status) ORDER BY sp.is_primary_contact DESC,sp.id) AS guardians
         FROM student_parents sp JOIN parents p ON p.school_id=sp.school_id AND p.id=sp.parent_id
         WHERE sp.school_id=s.school_id AND sp.student_id=s.id
       ) family ON true
       WHERE s.school_id=$1 AND concat_ws(' ',s.student_code,s.first_name,s.last_name,s.email::text) ILIKE $2
         AND ($3::uuid IS NULL OR s.id>$3) AND ($4::uuid IS NULL OR selected.academic_session IS NOT NULL)
       ORDER BY s.id LIMIT 500`,
        [school, `%${search}%`, cursor, session || null],
      )
    ).rows;
    if (!rows.length) return;
    for (const row of rows) {
      for (let i = 0; i < row.guardians.length; i++)
        for (const [field, value] of Object.entries(row.guardians[i]))
          row[`parent_${i + 1}_${field}`] = value;
      yield columns.map((column) => csvCell(row[column])).join(',') + '\r\n';
    }
    cursor = rows.at(-1)!.id;
  }
}
