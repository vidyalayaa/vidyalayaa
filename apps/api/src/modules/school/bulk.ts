import { Router } from 'express';
import type pg from 'pg';
import { bulkMarksSchema, singleMarkSchema, type MarksEntrySheet } from '@vidyalayaa/contracts';
import { z } from 'zod';
import { permission } from '../../middleware/auth.js';
import { asyncRoute, ApiError, notFound } from '../../lib/errors.js';
import { transaction, audit } from '../../lib/db.js';
import { requireWrite, withIdempotency } from './router.js';
import { assertMarkAccess } from './resources.js';
export function bulkRouter(pool: pg.Pool) {
  const r = Router();
  r.get(
    '/marks/entry-sheet',
    permission('marks.write'),
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        examId = z.guid().parse(req.query.exam_id);
      res.json(
        await transaction(
          pool,
          a.context,
          async (tx) => {
            await requireWrite(tx, a);
            const exam = (
              await tx.query(
                'SELECT id,name,class_id,assessment_kind,subject_id,max_score,status FROM exams WHERE school_id=$1 AND id=$2 AND retired_at IS NULL',
                [a.context.schoolId, examId],
              )
            ).rows[0];
            if (!exam) throw notFound();
            if (exam.status !== 'OPEN')
              throw new ApiError(409, 'EXAM_LOCKED', 'Only open exams accept marks.');
            if (
              a.active!.role === 'teacher' &&
              exam.assessment_kind === 'OFFICIAL' &&
              !(
                await tx.query('SELECT app.is_class_teacher($1,$2) AS allowed', [
                  a.context.schoolId,
                  exam.class_id,
                ])
              ).rows[0]?.allowed
            )
              throw new ApiError(
                403,
                'ASSESSMENT_ACCESS_DENIED',
                'Only the designated Class Teacher can enter official examination marks.',
              );
            const classroom = (
              await tx.query(
                'SELECT c.grade,c.section,ac.name AS academic_session FROM classes c JOIN academic_sessions ac ON ac.school_id=c.school_id AND ac.id=c.academic_session_id WHERE c.school_id=$1 AND c.id=$2 AND c.retired_at IS NULL AND ac.retired_at IS NULL',
                [a.context.schoolId, exam.class_id],
              )
            ).rows[0];
            if (!classroom) throw notFound();
            const subjects = (
              await tx.query(
                'SELECT id,code,name FROM subjects WHERE school_id=$1 AND retired_at IS NULL AND app.class_subject_configured(school_id,$2,id) AND ($3::uuid IS NULL OR id=$3) ORDER BY name,id',
                [
                  a.context.schoolId,
                  exam.class_id,
                  exam.assessment_kind === 'SUBJECT_TEST' ? exam.subject_id : null,
                ],
              )
            ).rows;
            for (const subject of subjects) await assertMarkAccess(tx, a, exam, subject.id);
            const students = (
              await tx.query(
                "SELECT DISTINCT ON (s.id) s.id,s.student_code,s.first_name,s.last_name,en.roll_number FROM enrollments en JOIN students s ON s.school_id=en.school_id AND s.id=en.student_id WHERE en.school_id=$1 AND en.class_id=$2 AND en.status='ACTIVE' AND s.status='ACTIVE' ORDER BY s.id,en.starts_on DESC,en.created_at DESC,en.id LIMIT 5001",
                [a.context.schoolId, exam.class_id],
              )
            ).rows;
            if (students.length > 5000)
              throw new ApiError(
                422,
                'CLASS_ROSTER_TOO_LARGE',
                'This class has more than 5,000 students. Review the class enrollments before entering marks.',
              );
            const natural = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
            students.sort(
              (x, y) =>
                Number(!x.roll_number?.trim()) - Number(!y.roll_number?.trim()) ||
                natural.compare(x.roll_number || '', y.roll_number || '') ||
                natural.compare(x.student_code, y.student_code) ||
                x.id.localeCompare(y.id),
            );
            const marks = (
              await tx.query(
                'SELECT student_id,subject_id,score,remarks FROM marks WHERE school_id=$1 AND exam_id=$2 AND student_id=ANY($3::uuid[]) AND subject_id=ANY($4::uuid[])',
                [a.context.schoolId, examId, students.map((s) => s.id), subjects.map((s) => s.id)],
              )
            ).rows.map((m) => ({ ...m, score: Number(m.score) }));
            return {
              exam: {
                id: exam.id,
                name: exam.name,
                class_id: exam.class_id,
                assessment_kind: exam.assessment_kind,
                subject_id: exam.subject_id,
                max_score: Number(exam.max_score),
              },
              classroom,
              subjects,
              students,
              marks,
            } satisfies MarksEntrySheet;
          },
          true,
        ),
      );
    }),
  );
  const saveMarks = (single: boolean) =>
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        b = (single ? singleMarkSchema : bulkMarksSchema).parse(req.body);
      res.json(
        await transaction(pool, a.context, async (tx) => {
          await requireWrite(tx, a);
          return withIdempotency(tx, a, req.header('Idempotency-Key'), b, async () => {
            const ex = (
              await tx.query('SELECT * FROM exams WHERE school_id=$1 AND id=$2 FOR UPDATE', [
                a.context.schoolId,
                b.exam_id,
              ])
            ).rows[0];
            if (!ex) throw notFound();
            if (ex.status !== 'OPEN')
              throw new ApiError(409, 'EXAM_LOCKED', 'Only open exams accept marks.');
            for (const subject of new Set(b.entries.map((x) => x.subject_id)))
              await assertMarkAccess(tx, a, ex, subject);
            const students = [...new Set(b.entries.map((x) => x.student_id))];
            const en = await tx.query(
              "SELECT DISTINCT student_id FROM enrollments WHERE school_id=$1 AND class_id=$2 AND student_id=ANY($3::uuid[]) AND status='ACTIVE'",
              [a.context.schoolId, ex.class_id, students],
            );
            const valid = new Set(en.rows.map((x) => x.student_id));
            const invalid = b.entries
              .map((entry, index) => ({ row: index + 1, entry }))
              .filter(
                (x) => !valid.has(x.entry.student_id) || x.entry.score > Number(ex.max_score),
              );
            if (invalid.length)
              throw new ApiError(
                422,
                'BULK_VALIDATION_FAILED',
                `No rows saved. Invalid enrollment or score at rows: ${invalid
                  .slice(0, 20)
                  .map((x) => x.row)
                  .join(', ')}.`,
                invalid.map(({ row, entry }) => ({
                  path: ['entries', row - 1, !valid.has(entry.student_id) ? 'student_id' : 'score'],
                  message: !valid.has(entry.student_id)
                    ? 'The student is not actively enrolled in this exam’s class.'
                    : `Score exceeds the exam maximum of ${ex.max_score}.`,
                })),
              );
            const saved = await tx.query(
              'INSERT INTO marks(school_id,exam_id,student_id,subject_id,score,remarks,entered_by) SELECT $1,$2,x.student_id,x.subject_id,x.score,x.remarks,$3 FROM jsonb_to_recordset($4::jsonb) x(student_id uuid,subject_id uuid,score numeric,remarks text) ON CONFLICT(school_id,exam_id,student_id,subject_id) DO UPDATE SET score=EXCLUDED.score,remarks=EXCLUDED.remarks,entered_by=EXCLUDED.entered_by RETURNING id',
              [a.context.schoolId, b.exam_id, a.id, JSON.stringify(b.entries)],
            );
            await audit(
              tx,
              a.context.schoolId,
              a.id,
              single ? 'marks.entry' : 'marks.bulk',
              'exams',
              ex.id,
            );
            return { saved: saved.rowCount };
          });
        }),
      );
    });
  r.post('/marks/bulk', permission('marks.write'), saveMarks(false));
  r.post('/marks/entry', permission('marks.write'), saveMarks(true));
  return r;
}
