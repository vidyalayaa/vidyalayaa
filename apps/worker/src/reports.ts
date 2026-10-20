import { mkdtemp, open, rm, rmdir } from 'node:fs/promises';
import { openAsBlob } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { captureFailure } from '../../api/src/lib/monitoring.js';
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
          "WITH picked AS(SELECT id FROM report_documents WHERE school_id=$1 AND (status='PENDING' OR (status='PROCESSING' AND locked_until<now())) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE report_documents r SET status='PROCESSING',lease_token=$2,locked_until=now()+CASE WHEN r.parameters->>'format'='CSV' THEN interval '20 minutes' ELSE interval '5 minutes' END FROM picked WHERE r.id=picked.id RETURNING r.*",
          [schoolId, lease],
        )
      ).rows[0],
  );
  if (!report) return;
  let temp: string | undefined, csvPath: string | undefined;
  const csv = report.parameters.format === 'CSV';
  try {
    if (csv) {
      temp = await mkdtemp(join(tmpdir(), 'vidyalayaa-report-'));
      if (
        dirname(resolve(temp)) !== resolve(tmpdir()) ||
        !basename(temp).startsWith('vidyalayaa-report-')
      )
        throw new Error('REPORT_TEMP_PATH_INVALID');
      csvPath = join(temp, 'report.csv');
    }
    const data = await transaction(
      pool,
      ctx,
      async (tx) => {
        const member = (
          await tx.query(
            "SELECT r.code,ARRAY(SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=r.id) AS permissions,app.report_scope_fingerprint(m.user_id) AS fingerprint FROM school_memberships m JOIN roles r ON r.id=m.role_id JOIN users u ON u.id=m.user_id AND u.status='ACTIVE' WHERE m.school_id=$1 AND m.user_id=$2 AND m.status='ACTIVE'",
            [schoolId, report.requested_by],
          )
        ).rows[0];
        if (!member) throw new Error('MEMBERSHIP_REVOKED');
        const needed =
          report.kind === 'FEES'
            ? 'fees.read'
            : report.kind === 'ACADEMIC'
              ? 'marks.read'
              : 'attendance.read';
        if (!member.permissions.includes('reports.export') || !member.permissions.includes(needed))
          throw new Error('PERMISSION_REVOKED');
        if (
          csv &&
          !(
            await tx.query(
              "SELECT p.features->>'advanced_reporting' AS enabled FROM subscriptions s JOIN subscription_plans p ON p.id=s.plan_id WHERE s.school_id=$1 ORDER BY s.created_at DESC LIMIT 1",
              [schoolId],
            )
          ).rows[0]?.enabled?.includes('true')
        )
          throw new Error('SUBSCRIPTION_FEATURE_UNAVAILABLE');
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
          ATTENDANCE: 't.attendance_date',
          ACADEMIC: 'coalesce(ex.starts_on,(t.created_at AT TIME ZONE sch.timezone)::date)',
          FEES: 't.due_on',
        }[report.kind as 'ATTENDANCE' | 'ACADEMIC' | 'FEES'];
        const columns = {
          ATTENDANCE:
            't.attendance_date,t.attendance_status,t.movement_status,t.first_arrival_at,t.last_departure_at',
          ACADEMIC:
            't.score,t.remarks,sub.name AS subject,ex.id AS exam_id,ex.name AS exam,ex.exam_type,ex.starts_on,ex.max_score',
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
        const base = `SELECT t.id AS record_id,s.student_code,s.first_name,s.last_name,${columns} FROM ${table} t JOIN students s ON s.school_id=t.school_id AND s.id=t.student_id JOIN schools sch ON sch.id=t.school_id ${joins} WHERE t.school_id=$1 AND $2::uuid IS NOT NULL AND ${studentScope(a, 't.student_id', '$2')} AND ($3::uuid IS NULL OR t.student_id=$3) AND ($4::uuid IS NULL OR ${report.kind === 'ACADEMIC' ? 'ex.class_id=$4' : report.kind === 'ATTENDANCE' ? 't.class_id=$4' : 'EXISTS(SELECT FROM enrollments en WHERE en.school_id=t.school_id AND en.student_id=t.student_id AND en.class_id=$4 AND en.starts_on<=t.due_on AND (en.ends_on IS NULL OR en.ends_on>=t.due_on))'}) AND ${dateColumn}>=$5::date AND ${dateColumn}<$6::date+1 ${examRestriction}`;
        const values = [
          schoolId,
          report.requested_by,
          report.student_id,
          report.class_id,
          report.parameters.from,
          report.parameters.to,
        ];
        let rows: Record<string, unknown>[] = [];
        if (csv) {
          const file = await open(csvPath!, 'wx', 0o600),
            started = Date.now();
          let cursor: string | null = null,
            header: string[] | undefined,
            bytes = 0;
          const cell = (v: unknown) => {
            const text =
              v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
            return (
              '"' +
              (/^[\s\uFEFF]*[=+@-]/.test(text) ? "'" + text : text).replaceAll('"', '""') +
              '"'
            );
          };
          try {
            for (;;) {
              if (Date.now() - started > 15 * 60000) throw new Error('REPORT_SNAPSHOT_DEADLINE');
              const page: Record<string, unknown>[] = (
                await tx.query(
                  base + ' AND ($7::uuid IS NULL OR t.id>$7) ORDER BY t.id LIMIT 500',
                  [...values, cursor],
                )
              ).rows;
              if (!page.length) {
                if (!header) await file.write('No matching records\r\n');
                break;
              }
              cursor = String(page.at(-1)!.record_id);
              let text = '';
              if (!header) {
                header = Object.keys(page[0]).filter((k) => k !== 'record_id');
                text = header.map(cell).join(',') + '\r\n';
              }
              text +=
                page.map((row) => header!.map((k) => cell(row[k])).join(',')).join('\r\n') + '\r\n';
              bytes += Buffer.byteLength(text);
              if (bytes > 19 * 1024 * 1024) throw new Error('REPORT_STORAGE_LIMIT');
              await file.writeFile(text);
            }
            await file.sync();
          } finally {
            await file.close();
          }
        } else {
          rows = (await tx.query(base + ' ORDER BY s.student_code,t.id LIMIT 10001', values)).rows;
          if (rows.length > 10000) throw new Error('REPORT_TOO_LARGE_USE_CSV');
          rows = rows.map(({ record_id, ...row }) => row);
        }
        const school = (
          await tx.query('SELECT name,access_version FROM schools WHERE id=$1', [schoolId])
        ).rows[0];
        return { rows, school, role: member.code, fingerprint: member.fingerprint };
      },
      true,
      'repeatable read',
    );
    const buffer = csv
      ? await openAsBlob(csvPath!, { type: 'text/csv' })
      : await makePdf(
          report.kind,
          data.school.name,
          data.rows,
          report.parameters.from,
          report.parameters.to,
        );
    const path = `${schoolId}/reports/${report.id}/${lease}.${csv ? 'csv' : 'pdf'}`;
    const own = await transaction(pool, ctx, (tx) =>
      tx.query(
        "UPDATE report_documents SET locked_until=now()+interval '5 minutes' WHERE id=$1 AND lease_token=$2 RETURNING id",
        [report.id, lease],
      ),
    );
    if (!own.rowCount) throw new Error('REPORT_LEASE_LOST');
    const uploaded = await storage.storage
      .from('school-documents')
      .upload(path, buffer, { contentType: csv ? 'text/csv' : 'application/pdf', upsert: false });
    if (uploaded.error) throw new Error('STORAGE_UNAVAILABLE');
    await transaction(pool, ctx, (tx) =>
      tx.query(
        "UPDATE report_documents SET status='COMPLETED',storage_path=$3,locked_until=NULL,authorization_version=$4,authorization_role=$5,authorization_scope=$6 WHERE id=$1 AND lease_token=$2",
        [report.id, lease, path, data.school.access_version, data.role, data.fingerprint],
      ),
    );
  } catch (error) {
    const current = await transaction(
      pool,
      ctx,
      async (tx) =>
        (await tx.query('SELECT status FROM report_documents WHERE id=$1', [report.id])).rows[0],
      true,
    );
    if (current?.status === 'COMPLETED') return;
    captureFailure(error, 'REPORT_FAILED');
    const code =
      error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'REPORT_FAILED';
    await transaction(pool, ctx, (tx) =>
      tx.query(
        "UPDATE report_documents SET status='FAILED',error_code=$3,locked_until=NULL WHERE id=$1 AND lease_token=$2 AND status='PROCESSING'",
        [report.id, lease, code],
      ),
    );
  } finally {
    if (csvPath) await rm(csvPath, { force: true });
    if (temp) await rmdir(temp);
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
    if (kind === 'ACADEMIC' && rows.length) {
      doc.fontSize(13).text('Student assessment summary').moveDown(0.4);
      for (const summary of academicSummaries(rows)) {
        if (doc.y > 700) doc.addPage();
        doc
          .fontSize(10)
          .fillColor('#171b16')
          .text(`${summary.student_code} - ${summary.name} | ${summary.exam}`);
        doc
          .fontSize(9)
          .fillColor('#555555')
          .text(
            `${summary.subjects} assessed subjects | Total ${summary.score.toFixed(2)} / ${summary.maximum.toFixed(2)} | ${summary.percentage.toFixed(2)}%`,
          )
          .moveDown(0.7);
      }
      doc
        .fontSize(9)
        .text(
          'Totals include recorded subjects only. Missing marks are not treated as zero. Grades require the school’s approved grading policy.',
        )
        .moveDown();
      doc.fontSize(13).fillColor('#171b16').text('Subject results and remarks').moveDown(0.5);
    }
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
            .filter(([k]) => !['student_code', 'first_name', 'last_name', 'exam_id'].includes(k))
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
export function academicSummaries(rows: Record<string, unknown>[]) {
  const groups = new Map<
    string,
    {
      student_code: string;
      name: string;
      exam: string;
      subjects: number;
      score: number;
      maximum: number;
      percentage: number;
    }
  >();
  for (const row of rows) {
    const key = `${row.student_code}:${row.exam_id}`;
    const s = groups.get(key) || {
      student_code: String(row.student_code),
      name: `${row.first_name} ${row.last_name || ''}`.trim(),
      exam: String(row.exam),
      subjects: 0,
      score: 0,
      maximum: 0,
      percentage: 0,
    };
    s.subjects++;
    s.score += Number(row.score);
    s.maximum += Number(row.max_score);
    s.percentage = s.maximum ? (s.score / s.maximum) * 100 : 0;
    groups.set(key, s);
  }
  return [...groups.values()];
}
