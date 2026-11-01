import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { uuid } from '@vidyalayaa/contracts';
import { transaction } from '../../lib/db.js';
import { asyncRoute, notFound } from '../../lib/errors.js';
import type { Actor } from '../../middleware/auth.js';
// Mounted below the School Admin gate. Selecting a year never changes current year.
export function yearHistoryRouter(pool: pg.Pool) {
  const r = Router();
  r.get(
    '/:sessionId',
    asyncRoute(async (req, res) => {
      const a: Actor = res.locals.actor,
        sid = a.context.schoolId,
        sessionId = uuid.parse(req.params.sessionId),
        q = z
          .object({
            section: z
              .enum([
                'students',
                'attendance',
                'results',
                'homework',
                'subjects',
                'timetable',
                'fees',
                'payments',
              ])
              .default('students'),
            class_id: uuid.optional(),
            page: z.coerce.number().int().min(1).default(1),
          })
          .strict()
          .parse(req.query);
      const scopes = {
        students: `SELECT e.id,s.student_code,concat_ws(' ',s.first_name,s.last_name) AS student,c.grade,c.section,e.roll_number,e.starts_on::text AS enrolled_from,e.ends_on::text AS enrolled_until,e.status FROM enrollments e JOIN students s ON s.school_id=e.school_id AND s.id=e.student_id JOIN classes c ON c.school_id=e.school_id AND c.id=e.class_id WHERE e.school_id=$1 AND e.academic_session_id=$2 AND ($3::uuid IS NULL OR e.class_id=$3)`,
        attendance: `SELECT d.id,s.student_code,concat_ws(' ',s.first_name,s.last_name) AS student,c.grade,c.section,d.attendance_date::text AS date,d.attendance_status AS status FROM daily_attendance d JOIN students s ON s.school_id=d.school_id AND s.id=d.student_id JOIN classes c ON c.school_id=d.school_id AND c.id=d.class_id WHERE d.school_id=$1 AND c.academic_session_id=$2 AND ($3::uuid IS NULL OR d.class_id=$3)`,
        results: `SELECT m.id,s.student_code,concat_ws(' ',s.first_name,s.last_name) AS student,c.grade,c.section,ex.name AS examination,ex.status AS examination_status,sub.name AS subject,m.score,ex.max_score,m.remarks FROM marks m JOIN students s ON s.school_id=m.school_id AND s.id=m.student_id JOIN exams ex ON ex.school_id=m.school_id AND ex.id=m.exam_id JOIN classes c ON c.school_id=ex.school_id AND c.id=ex.class_id JOIN subjects sub ON sub.school_id=m.school_id AND sub.id=m.subject_id WHERE m.school_id=$1 AND c.academic_session_id=$2 AND ($3::uuid IS NULL OR c.id=$3)`,
        homework: `SELECT t.id,c.grade,c.section,s.name AS subject,t.kind,t.title,t.body AS description,t.assigned_on::text AS assigned_date,t.due_at,t.instructions,t.reference_url,(t.retired_at IS NOT NULL) AS archived FROM assignments t JOIN classes c ON c.school_id=t.school_id AND c.id=t.class_id LEFT JOIN subjects s ON s.school_id=t.school_id AND s.id=t.subject_id WHERE t.school_id=$1 AND c.academic_session_id=$2 AND ($3::uuid IS NULL OR c.id=$3)`,
        subjects: `SELECT ta.id,c.grade,c.section,s.name AS subject,te.full_name AS teacher,ct.full_name AS class_teacher,ta.starts_on::text AS assigned_from,ta.ends_on::text AS assigned_until,(ta.retired_at IS NOT NULL) AS archived FROM teacher_class_assignments ta JOIN classes c ON c.school_id=ta.school_id AND c.id=ta.class_id LEFT JOIN subjects s ON s.school_id=ta.school_id AND s.id=ta.subject_id JOIN teachers te ON te.school_id=ta.school_id AND te.id=ta.teacher_id LEFT JOIN teachers ct ON ct.school_id=c.school_id AND ct.id=c.class_teacher_id WHERE ta.school_id=$1 AND c.academic_session_id=$2 AND ($3::uuid IS NULL OR c.id=$3)`,
        timetable: `SELECT t.id,c.grade,c.section,t.weekday,t.starts_at::text AS start_time,t.ends_at::text AS end_time,s.name AS subject,te.full_name AS teacher,t.room,(t.retired_at IS NOT NULL) AS archived FROM timetable_entries t JOIN classes c ON c.school_id=t.school_id AND c.id=t.class_id JOIN subjects s ON s.school_id=t.school_id AND s.id=t.subject_id JOIN teachers te ON te.school_id=t.school_id AND te.id=t.teacher_id WHERE t.school_id=$1 AND c.academic_session_id=$2 AND ($3::uuid IS NULL OR c.id=$3)`,
        fees: `SELECT f.id,s.student_code,concat_ws(' ',s.first_name,s.last_name) AS student,c.grade,c.section,f.fee_type,f.installment_label,f.due_on::text AS due_date,f.amount_due,f.amount_paid,CASE WHEN f.voided_at IS NOT NULL OR f.status='WAIVED' THEN 0 ELSE f.amount_due-f.amount_paid END AS balance,f.currency,f.status FROM fee_records f JOIN students s ON s.school_id=f.school_id AND s.id=f.student_id LEFT JOIN classes c ON c.school_id=f.school_id AND c.id=f.class_id WHERE f.school_id=$1 AND f.academic_session_id=$2 AND ($3::uuid IS NULL OR f.class_id=$3)`,
        payments: `SELECT p.id,s.student_code,concat_ws(' ',s.first_name,s.last_name) AS student,p.receipt_no,p.payment_date::text AS payment_date,p.amount,p.currency,p.payment_method,p.kind,p.reference FROM fee_payments p JOIN students s ON s.school_id=p.school_id AND s.id=p.student_id WHERE p.school_id=$1 AND p.academic_session_id=$2 AND ($3::uuid IS NULL OR EXISTS(SELECT FROM enrollments e WHERE e.school_id=p.school_id AND e.student_id=p.student_id AND e.academic_session_id=$2 AND e.class_id=$3))`,
      };
      const columns = {
        students: [
          'student_code',
          'student',
          'grade',
          'section',
          'roll_number',
          'enrolled_from',
          'enrolled_until',
          'status',
        ],
        attendance: ['student_code', 'student', 'grade', 'section', 'date', 'status'],
        results: [
          'student_code',
          'student',
          'grade',
          'section',
          'examination',
          'examination_status',
          'subject',
          'score',
          'max_score',
          'remarks',
        ],
        homework: [
          'grade',
          'section',
          'subject',
          'kind',
          'title',
          'description',
          'assigned_date',
          'due_at',
          'instructions',
          'reference_url',
          'archived',
        ],
        subjects: [
          'grade',
          'section',
          'subject',
          'teacher',
          'class_teacher',
          'assigned_from',
          'assigned_until',
          'archived',
        ],
        timetable: [
          'grade',
          'section',
          'weekday',
          'start_time',
          'end_time',
          'subject',
          'teacher',
          'room',
          'archived',
        ],
        fees: [
          'student_code',
          'student',
          'grade',
          'section',
          'fee_type',
          'installment_label',
          'due_date',
          'amount_due',
          'amount_paid',
          'balance',
          'currency',
          'status',
        ],
        payments: [
          'student_code',
          'student',
          'receipt_no',
          'payment_date',
          'amount',
          'currency',
          'payment_method',
          'kind',
          'reference',
        ],
      };
      res.json(
        await transaction(
          pool,
          a.context,
          async (tx) => {
            const session = (
              await tx.query(
                'SELECT id,name,starts_on::text AS starts_on,ends_on::text AS ends_on,is_current,closed_at FROM academic_sessions WHERE school_id=$1 AND id=$2',
                [sid, sessionId],
              )
            ).rows[0];
            if (!session) throw notFound();
            const params = [sid, sessionId, q.class_id || null],
              sql = scopes[q.section];
            const total = Number(
              (await tx.query(`SELECT count(*) FROM (${sql}) x`, params)).rows[0].count,
            );
            const data = (
              await tx.query(`SELECT * FROM (${sql}) x ORDER BY id LIMIT 50 OFFSET $4`, [
                ...params,
                (q.page - 1) * 50,
              ])
            ).rows;
            return {
              session,
              columns: columns[q.section],
              data,
              total,
              page: q.page,
              page_size: 50,
            };
          },
          true,
        ),
      );
    }),
  );
  return r;
}
