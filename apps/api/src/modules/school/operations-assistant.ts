import { Router } from 'express';
import type pg from 'pg';
import {
  operationsQuestionSchema,
  operationsStaffRoles,
  operationsTopicPermissions,
  operationsTopics,
  defaultSchoolTimings,
  type OperationsAnswer,
  type OperationsTopic,
  type SchoolTimings,
} from '@vidyalayaa/contracts';
import type { Config } from '../../lib/config.js';
import { transaction, type Tx } from '../../lib/db.js';
import { ApiError, asyncRoute } from '../../lib/errors.js';
import type { Actor } from '../../middleware/auth.js';
import { localParts } from '../attendance/engine.js';
import { academicAi, analysisKey } from './academic-ai.js';
import { readAttendanceCalendar } from './attendance-calendar.js';
import { studentScope } from './resources.js';

const questions: Record<OperationsTopic, RegExp> = {
  attendance:
    /^(?:which classes (?:haven't|have not) (?:submitted|marked|recorded) attendance today|which classes (?:still )?need attendance today|(?:show )?(?:today's attendance gaps|attendance gaps today|unmarked attendance today))$/,
  fees: /^(?:which (?:fees|fee payments) are overdue|(?:show )?overdue fees|how much is overdue in fees)(?: this month)?$/,
  corrections:
    /^(?:which attendance corrections (?:are pending|need review)|(?:show )?pending attendance corrections|how many attendance corrections (?:are pending|need review))$/,
  devices:
    /^(?:which (?:rfid |nfc )?(?:devices|readers) are offline|(?:show )?offline (?:rfid |nfc )?(?:devices|readers)|how many (?:rfid |nfc )?(?:devices|readers) are offline)$/,
  timetable:
    /^(?:(?:which|what) class(?:es)? (?:has|have) no (?:lecture|lesson|period)s?(?: scheduled)?|(?:which|what) class(?:es)? (?:is|are) free|(?:show )?free class(?:es)?)(?: (?:currently|right now|now|at the moment))$/,
};

type Note = OperationsAnswer['notes'][number];
const quantity = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;
const noAccess = 'You don’t have access to that information through Ask Vidyalayaa.';

async function readTimetableNote(
  tx: Tx,
  school: string,
  { date, time }: ReturnType<typeof localParts>,
): Promise<Note> {
  const topic = 'timetable';
  const weekday = new Date(date).getUTCDay() || 7;
  const { timings } = (
    await tx.query<{ timings: SchoolTimings | null }>(
      "SELECT settings->'timetable' AS timings FROM schools WHERE id=$1",
      [school],
    )
  ).rows[0];
  const settings = timings ?? defaultSchoolTimings;
  const currentTime = time.slice(0, 5);
  const period = settings.periods.find(
    (slot) => slot.start_time <= currentTime && currentTime < slot.end_time,
  );
  if (!settings.days.includes(weekday))
    return { topic, text: 'No regular lectures are scheduled for this day of the week.' };
  if (!period)
    return { topic, text: 'It’s currently outside the school’s scheduled lecture periods.' };

  const classes = (
    await tx.query<{ grade: string; section: string; configured: boolean; occupied: boolean }>(
      `SELECT c.grade,c.section,count(t.id)>0 AS configured,
         coalesce(bool_or(t.weekday=$3 AND t.starts_at<=$4::time AND t.ends_at>$4::time),false) AS occupied
       FROM classes c
       JOIN academic_sessions ac ON (ac.school_id,ac.id)=(c.school_id,c.academic_session_id)
       LEFT JOIN timetable_entries t ON (t.school_id,t.class_id)=(c.school_id,c.id)
         AND t.retired_at IS NULL
       WHERE c.school_id=$1 AND ac.is_current AND $2::date BETWEEN ac.starts_on AND ac.ends_on
         AND app.timetable_class_visible(c.school_id,c.id)
         AND NOT EXISTS (
           SELECT 1 FROM school_holidays h
           WHERE h.school_id=c.school_id AND h.kind='HOLIDAY' AND h.retired_at IS NULL
             AND $2::date BETWEEN h.on_date AND coalesce(h.ends_on,h.on_date)
             AND (cardinality(h.target_class_ids)=0 OR c.id=ANY(h.target_class_ids))
         )
       GROUP BY c.id,c.grade,c.section ORDER BY c.grade,c.section,c.id`,
      [school, date, weekday, time],
    )
  ).rows;
  if (!classes.length) return { topic, text: 'No timetable classes are in scope for today.' };
  const unknown = classes.filter((row) => !row.configured).length;
  if (unknown === classes.length)
    return { topic, text: 'No timetable entries have been added for the classes you can view.' };
  const free = classes.filter((row) => row.configured && !row.occupied);
  return {
    topic,
    text: `${quantity(free.length, 'class has', 'classes have')} no lecture scheduled at ${currentTime} school time.${
      unknown
        ? ` ${quantity(unknown, 'class has', 'classes have')} no timetable entries and could not be checked.`
        : ''
    }`,
    details: free.slice(0, 20).map(({ grade, section }) => `Class ${grade} · ${section}`),
  };
}

async function readNote(
  tx: Tx,
  actor: Actor,
  topic: OperationsTopic,
  local: ReturnType<typeof localParts>,
  thisMonth: boolean,
): Promise<Note> {
  const school = actor.context.schoolId;
  const { date } = local;
  if (topic === 'timetable') return readTimetableNote(tx, school, local);
  if (topic === 'attendance') {
    const days = await readAttendanceCalendar(
      tx,
      actor,
      { school, family: false, student: undefined },
      {},
      date,
      date,
      date,
      true,
    );
    const working = days.filter((day) => day.working > 0);
    const gaps = working.filter((day) => day.unmarked + day.pending > 0);
    const classes = (
      await tx.query<{ id: string; grade: string; section: string }>(
        'SELECT id,grade,section FROM classes WHERE school_id=$1 AND id=ANY($2::uuid[]) ORDER BY grade,section,id',
        [school, gaps.flatMap((day) => (day.class_id ? [day.class_id] : []))],
      )
    ).rows;
    const byClass = new Map(gaps.map((day) => [day.class_id, day]));
    return {
      topic,
      text: working.length
        ? `${quantity(gaps.length, 'class has', 'classes have')} pending or unmarked attendance today.`
        : 'No scheduled attendance was found for your visible classes today.',
      details: classes.slice(0, 20).map(({ id, grade, section }) => {
        const day = byClass.get(id)!;
        return `Class ${grade} · ${section} · ${day.unmarked} unmarked, ${day.pending} pending`;
      }),
    };
  }
  if (topic === 'fees') {
    const rows = (
      await tx.query<{ currency: string; total: string; count: number }>(
        `SELECT f.currency,sum(f.amount_due-f.amount_paid)::text AS total,count(*)::int AS count
       FROM fee_records f WHERE f.school_id=$1 AND app.fee_student_visible(f.school_id,f.student_id)
       AND f.status<>'WAIVED' AND f.voided_at IS NULL AND f.amount_due>f.amount_paid
       AND f.due_on<$2::date AND (NOT $3::boolean OR f.due_on>=date_trunc('month',$2::date)::date)
       GROUP BY f.currency ORDER BY f.currency`,
        [school, date, thisMonth],
      )
    ).rows;
    return {
      topic,
      text: `${quantity(
        rows.reduce((sum, row) => sum + row.count, 0),
        'fee assessment is',
        'fee assessments are',
      )} overdue${thisMonth ? ' with a due date this month' : ''}.`,
      details: rows.map(({ currency, total }) => `${currency} ${total} outstanding`),
    };
  }
  if (topic === 'corrections') {
    const { count } = (
      await tx.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM attendance_corrections c
       JOIN daily_attendance t ON (t.school_id,t.id)=(c.school_id,c.daily_attendance_id)
       JOIN students s ON (s.school_id,s.id)=(t.school_id,t.student_id)
       WHERE c.school_id=$1 AND c.status='REQUESTED' AND c.requested_by<>$2
       AND ${studentScope(actor, 't.student_id', '$2')}`,
        [school, actor.id],
      )
    ).rows[0];
    return {
      topic,
      text: `${quantity(count, 'attendance correction is', 'attendance corrections are')} waiting for review.`,
    };
  }
  const rows = (
    await tx.query<{ device_code: string; count: number }>(
      `SELECT d.device_code,count(*) OVER ()::int AS count FROM devices d JOIN schools s ON s.id=d.school_id
     WHERE d.school_id=$1 AND d.status='ACTIVE'
     AND (d.last_seen_at IS NULL OR d.last_seen_at<now()-make_interval(mins=>app.reader_offline_minutes(s.settings)))
     ORDER BY d.device_code LIMIT 20`,
      [school],
    )
  ).rows;
  return {
    topic,
    text: `${quantity(rows[0]?.count ?? 0, 'active RFID device is', 'active RFID devices are')} offline.`,
    details: rows.map(({ device_code }) => device_code),
  };
}

export function operationsAssistantRouter(pool: pg.Pool, config: Config) {
  const router = Router();
  const ai = academicAi(config);
  router.post(
    '/',
    asyncRoute(async (req, res) => {
      const actor: Actor = res.locals.actor;
      const active = actor.active;
      if (!active || !operationsStaffRoles.some((role) => role === active.role))
        throw new ApiError(403, 'FORBIDDEN', noAccess);
      const permitted = operationsTopics.filter(
        (topic) =>
          (topic !== 'timetable' || actor.features.timetable) &&
          operationsTopicPermissions[topic].every((permission) =>
            active.permissions.includes(permission),
          ),
      );
      const request = operationsQuestionSchema.parse(req.body);
      const question =
        request.kind === 'question'
          ? request.question
              .toLowerCase()
              .replace(/’/g, "'")
              .replace(/\s+/g, ' ')
              .replace(/[?!.]+$/, '')
          : '';
      const topic = operationsTopics.find((item) => questions[item].test(question));
      if (request.kind === 'question' && (!topic || (request.topic && topic !== request.topic)))
        throw new ApiError(422, 'UNSUPPORTED_OPERATIONS_QUESTION', noAccess);
      if ((topic && !permitted.includes(topic)) || !permitted.length)
        throw new ApiError(403, 'FORBIDDEN', noAccess);
      const topics = topic ? [topic] : permitted;
      const local = localParts(new Date(), active.timezone);
      const { date } = local;
      const notes = await transaction(
        pool,
        actor.context,
        async (tx) => {
          const result: Note[] = [];
          for (const item of topics)
            result.push(await readNote(tx, actor, item, local, question.endsWith(' this month')));
          return result;
        },
        true,
        'repeatable read',
      );
      const answer: OperationsAnswer = { date, notes };
      const facts = notes.map(({ topic, text }) => ({ topic, text }));
      try {
        const result = await ai.operationsBrief(
          facts,
          analysisKey(['operations', actor.context.schoolId, date, facts]),
        );
        answer.summary = result.summary;
      } catch (error) {
        if (
          !(error instanceof ApiError) ||
          ![
            'ACADEMIC_AI_UNCONFIGURED',
            'ACADEMIC_AI_BUSY',
            'ACADEMIC_AI_LIMIT',
            'ACADEMIC_AI_UNAVAILABLE',
          ].includes(error.code)
        )
          throw error;
      }
      res.set('Cache-Control', 'private, no-store').json(answer);
    }),
  );
  return router;
}
