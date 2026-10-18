import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import PDFDocument from 'pdfkit';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Actor } from '../../api/src/middleware/auth.js';
import { transaction } from '../../api/src/lib/db.js';
import {
  studentScope,
  classScope,
  assertStudent,
  assertClass,
} from '../../api/src/modules/school/resources.js';
export async function generateReports(pool: pg.Pool, schoolId: string, storage: SupabaseClient) {
  const ctx = { schoolId, actorType: 'SYSTEM' as const },
    lease = randomUUID();
  const report = await transaction(
    pool,
    ctx,
    async (tx) =>
      (
        await tx.query(
          "WITH picked AS(SELECT id FROM report_documents WHERE school_id=$1 AND (status='PENDING' OR (status='PROCESSING' AND locked_until<now())) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE report_documents r SET status='PROCESSING',lease_token=$2,locked_until=now()+interval '5 minutes' FROM picked WHERE r.id=picked.id RETURNING r.*",
          [schoolId, lease],
        )
      ).rows[0],
  );
  if (!report) return;
  try {
    const data = await transaction(
      pool,
      ctx,
      async (tx) => {
        const member = (
          await tx.query(
            "SELECT r.code FROM school_memberships m JOIN roles r ON r.id=m.role_id WHERE m.school_id=$1 AND m.user_id=$2 AND m.status='ACTIVE'",
            [schoolId, report.requested_by],
          )
        ).rows[0];
        if (!member) throw new Error('MEMBERSHIP_REVOKED');
        if (report.kind === 'FEES' && member.code === 'teacher')
          throw new Error('PERMISSION_REVOKED');
        const a = {
          id: report.requested_by,
          active: { role: member.code },
          context: { schoolId, userId: report.requested_by },
        } as Actor;
        if (report.student_id) await assertStudent(tx, a, report.student_id);
        if (report.class_id) await assertClass(tx, a, report.class_id);
        if (['parent', 'student'].includes(member.code) && !report.student_id)
          throw new Error('STUDENT_REQUIRED');
        const table = { ATTENDANCE: 'daily_attendance', ACADEMIC: 'marks', FEES: 'fee_records' }[
          report.kind as 'ATTENDANCE' | 'ACADEMIC' | 'FEES'
        ];
        const dateColumn = {
          ATTENDANCE: 'attendance_date',
          ACADEMIC: 'created_at::date',
          FEES: 'due_on',
        }[report.kind as 'ATTENDANCE' | 'ACADEMIC' | 'FEES'];
        const columns = {
          ATTENDANCE:
            't.attendance_date,t.attendance_status,t.movement_status,t.first_arrival_at,t.last_departure_at',
          ACADEMIC: 't.score,sub.name AS subject,ex.name AS exam,ex.max_score',
          FEES: 't.fee_type,t.amount_due,t.amount_paid,t.currency,t.due_on,t.status',
        }[report.kind as 'ATTENDANCE' | 'ACADEMIC' | 'FEES'];
        const joins =
          report.kind === 'ACADEMIC'
            ? ' JOIN subjects sub ON sub.school_id=t.school_id AND sub.id=t.subject_id JOIN exams ex ON ex.school_id=t.school_id AND ex.id=t.exam_id'
            : '';
        const examRestriction =
          report.kind === 'ACADEMIC'
            ? ` AND ${classScope(a, 'ex.class_id', '$2', 't.subject_id')}${['parent', 'student'].includes(member.code) ? " AND ex.status='PUBLISHED'" : ''}`
            : '';
        const rows = (
          await tx.query(
            `SELECT s.student_code,s.first_name,s.last_name,${columns} FROM ${table} t JOIN students s ON s.school_id=t.school_id AND s.id=t.student_id ${joins} WHERE t.school_id=$1 AND ${studentScope(a, 't.student_id', '$2')} AND ($3::uuid IS NULL OR t.student_id=$3) AND ($4::uuid IS NULL OR EXISTS(SELECT FROM enrollments en WHERE en.school_id=t.school_id AND en.student_id=t.student_id AND en.class_id=$4)) AND t.${dateColumn}>=$5::date AND t.${dateColumn}<$6::date+1 ${examRestriction} ORDER BY s.student_code LIMIT 10001`,
            [
              schoolId,
              report.requested_by,
              report.student_id,
              report.class_id,
              report.parameters.from,
              report.parameters.to,
            ],
          )
        ).rows;
        if (rows.length > 10000) throw new Error('REPORT_TOO_LARGE');
        const school = (await tx.query('SELECT name FROM schools WHERE id=$1', [schoolId])).rows[0];
        return { rows, school };
      },
      true,
    );
    const buffer = await makePdf(
      report.kind,
      data.school.name,
      data.rows,
      report.parameters.from,
      report.parameters.to,
    );
    const path = `${schoolId}/reports/${report.id}.pdf`;
    const uploaded = await storage.storage
      .from('school-documents')
      .upload(path, buffer, { contentType: 'application/pdf', upsert: true });
    if (uploaded.error) throw new Error('STORAGE_UNAVAILABLE');
    await transaction(pool, ctx, (tx) =>
      tx.query(
        "UPDATE report_documents SET status='COMPLETED',storage_path=$3,locked_until=NULL WHERE id=$1 AND lease_token=$2",
        [report.id, lease, path],
      ),
    );
  } catch (error) {
    const code =
      error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'REPORT_FAILED';
    await transaction(pool, ctx, (tx) =>
      tx.query(
        "UPDATE report_documents SET status='FAILED',error_code=$3,locked_until=NULL WHERE id=$1 AND lease_token=$2",
        [report.id, lease, code],
      ),
    );
  }
}
function makePdf(
  kind: string,
  school: string,
  rows: Record<string, unknown>[],
  from: string,
  to: string,
): Promise<Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({
        size: 'A4',
        margin: 42,
        info: { Title: `Vidyalayaa ${kind} report` },
      }),
      chunks: Buffer[] = [];
    doc.on('data', (b: Buffer) => chunks.push(b));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.fontSize(26).fillColor('#171b16').text('Vidyalayaa');
    doc.fontSize(15).text(school).moveDown();
    doc
      .fontSize(18)
      .text(`${kind.toLowerCase()} report`)
      .fontSize(10)
      .text(`${from} to ${to} | Generated ${new Date().toISOString()}`)
      .moveDown();
    if (!rows.length) doc.text('No matching records in this period.');
    for (const row of rows) {
      if (doc.y > 730) doc.addPage();
      doc
        .fontSize(10)
        .fillColor('#171b16')
        .text(`${row.student_code} - ${row.first_name} ${row.last_name || ''}`);
      doc
        .fontSize(8)
        .fillColor('#555555')
        .text(
          Object.entries(row)
            .filter(([k]) => !['student_code', 'first_name', 'last_name'].includes(k))
            .map(
              ([k, v]) =>
                `${k.replaceAll('_', ' ')}: ${v instanceof Date ? v.toISOString() : (v ?? '-')}`,
            )
            .join(' | '),
          { width: 510 },
        );
      doc.moveDown();
    }
    doc.end();
  });
}
