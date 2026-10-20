import type pg from 'pg';
import {
  ruleSchema,
  type DeviceEvent,
  type EventResult,
  type RuleSet,
} from '@vidyalayaa/contracts';
import { transaction, type Tx } from '../../lib/db.js';
import {
  fold,
  emptyDay,
  localParts,
  trustedTime,
  type FoldEvent,
  type DayState,
} from './engine.js';
export interface Device {
  id: string;
  schoolId: string;
  code: string;
  status: string;
}
export async function resolveRules(
  tx: Tx,
  school: string,
  classId: string,
  date: string,
  pinned?: string,
) {
  const { rows: holidays } = await tx.query(
    'SELECT kind FROM school_holidays WHERE school_id=$1 AND retired_at IS NULL AND on_date=$2 AND (class_id=$3 OR class_id IS NULL) ORDER BY class_id NULLS LAST',
    [school, date, classId],
  );
  const day = holidays[0]?.kind;
  const type = day === 'EXAM_DAY' ? 'EXAM' : day === 'SHORT_DAY' ? 'SHORT_DAY' : 'REGULAR';
  const { rows } = await tx.query(
    'SELECT * FROM attendance_rule_versions WHERE school_id=$1 AND (($5::uuid IS NOT NULL AND id=$5) OR ($5::uuid IS NULL AND (class_id=$3 OR class_id IS NULL) AND day_type=$4 AND effective_from<=$2 AND (effective_to IS NULL OR effective_to>$2))) ORDER BY class_id NULLS LAST,effective_from DESC LIMIT 1',
    [school, date, classId, type, pinned || null],
  );
  return { rule: rows[0], holiday: day === 'HOLIDAY', weekendOverride: day === 'WEEKEND_OVERRIDE' };
}
export async function queue(
  tx: Tx,
  school: string,
  student: string | null,
  kind: string,
  dedupe: string,
  payload: Record<string, unknown>,
  event?: string,
) {
  const r = await tx.query(
    'INSERT INTO notification_outbox(school_id,student_id,kind,dedupe_key,payload,source_event_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(school_id,dedupe_key) DO NOTHING RETURNING id',
    [school, student, kind, dedupe, payload, event || null],
  );
  return !!r.rowCount;
}
export async function processEvent(
  pool: pg.Pool,
  d: Device,
  e: DeviceEvent,
  requestId: string,
  reprocess = false,
): Promise<EventResult> {
  return transaction(pool, { schoolId: d.schoolId, actorType: 'DEVICE', requestId }, async (tx) => {
    // Revocation/location are rechecked inside every event transaction, including long batches.
    if (!(await tx.query('SELECT app.lock_active_device($1) AS locked', [d.id])).rows[0]?.locked)
      throw new Error('DEVICE_UNAVAILABLE');
    const { rows: devices } = await tx.query(
      "SELECT d.*,l.location_type,l.is_active,s.timezone FROM devices d JOIN schools s ON s.id=d.school_id LEFT JOIN device_locations l ON l.school_id=d.school_id AND l.id=d.location_id WHERE d.id=$1 AND d.status='ACTIVE'",
      [d.id],
    );
    const device = devices[0];
    if (!device || !device.is_active) throw new Error('DEVICE_UNAVAILABLE');
    const { rows: refs } = await tx.query(
      'SELECT boot_reference_time,skew_ms FROM device_heartbeats WHERE school_id=$1 AND device_id=$2 AND boot_id=$3 ORDER BY received_at DESC LIMIT 1',
      [d.schoolId, d.id, e.boot_id],
    );
    const received = new Date(),
      t = trustedTime(
        refs[0] && Math.abs(Number(refs[0].skew_ms)) > 120000
          ? { ...e, time_source: 'RTC_UNSYNCED' }
          : e,
        received,
        refs[0]?.boot_reference_time,
        300,
      );
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `${d.schoolId}:card:${e.card_uid}`,
    ]);
    const { rows: claimed } = reprocess
      ? await tx.query(
          "SELECT id FROM attendance_events WHERE school_id=$1 AND device_id=$2 AND device_event_id=$3 AND outcome IN ('STORED_PENDING_RULES','QUARANTINED_TIMESTAMP') FOR UPDATE",
          [d.schoolId, d.id, e.event_id],
        )
      : await tx.query(
          `INSERT INTO attendance_events(school_id,device_id,device_event_id,sequence_number,boot_id,card_uid,location_id,location_type,event_ts,effective_ts,time_source,timestamp_trust,uptime_ms,firmware_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(device_id,device_event_id) DO NOTHING RETURNING id`,
          [
            d.schoolId,
            d.id,
            e.event_id,
            e.sequence_number,
            e.boot_id,
            e.card_uid,
            device.location_id,
            device.location_type,
            e.event_timestamp,
            t.effective,
            e.time_source,
            t.trust,
            e.uptime_ms ?? null,
            e.firmware_version,
          ],
        );
    if (!claimed.length) {
      const { rows } = await tx.query(
        'SELECT result,status,outcome,processed_at FROM attendance_events WHERE device_id=$1 AND device_event_id=$2',
        [d.id, e.event_id],
      );
      const old = rows[0];
      return {
        event_id: e.event_id,
        status: 'DUPLICATE_EVENT',
        original_status: old.status,
        original_outcome: old.outcome,
        processed_at: old.processed_at?.toISOString(),
        notification_queued: false,
        device_action: 'DELETE',
      };
    }
    const id = claimed[0].id;
    if (reprocess)
      await tx.query(
        'UPDATE attendance_events SET effective_ts=$2,timestamp_trust=$3 WHERE id=$1',
        [id, t.effective, t.trust],
      );
    let result: EventResult = {
      event_id: e.event_id,
      status: 'REJECTED',
      outcome: 'REJECTED_UNKNOWN_CARD',
      notification_queued: false,
      device_action: 'DELETE',
    };
    const save = async () => {
      if (['REJECTED_CARD_BLOCKED', 'QUARANTINED_TIMESTAMP'].includes(result.outcome || ''))
        await tx.query('SELECT app.queue_device_security_alert($1,$2,$3)', [
          result.outcome,
          id,
          d.id,
        ]);
      await tx.query(
        'UPDATE attendance_events SET status=$2,outcome=$3,result=$4,processed_at=now() WHERE id=$1',
        [id, result.status, result.outcome, result],
      );
      return result;
    };
    const { rows: cards } = await tx.query(
      "SELECT c.*,s.status AS student_status FROM nfc_cards c JOIN students s ON s.school_id=c.school_id AND s.id=c.student_id WHERE c.school_id=$1 AND c.card_uid=$2 AND c.status<>'RETIRED'",
      [d.schoolId, e.card_uid],
    );
    const card = cards[0];
    if (!card) return save();
    if (card.status !== 'ACTIVE') {
      result.outcome = 'REJECTED_CARD_BLOCKED';
      return save();
    }
    await tx.query('UPDATE attendance_events SET student_id=$2,nfc_card_id=$3 WHERE id=$1', [
      id,
      card.student_id,
      card.id,
    ]);
    const local = localParts(t.effective, device.timezone);
    const { rows: enrollments } = await tx.query(
      'SELECT * FROM enrollments WHERE school_id=$1 AND student_id=$2 AND starts_on<=$3 AND (ends_on IS NULL OR ends_on>=$3) ORDER BY starts_on DESC LIMIT 1',
      [d.schoolId, card.student_id, local.date],
    );
    const en = enrollments[0];
    if (!en || card.student_status !== 'ACTIVE') {
      result.outcome = 'REJECTED_NO_ACTIVE_ENROLLMENT';
      return save();
    }
    result.status = 'RECORDED';
    if (t.trust === 'SUSPECT') {
      result.outcome = 'QUARANTINED_TIMESTAMP';
      return save();
    }
    const prior = (
      await tx.query(
        'SELECT rule_version_id FROM daily_attendance WHERE school_id=$1 AND student_id=$2 AND attendance_date=$3',
        [d.schoolId, card.student_id, local.date],
      )
    ).rows[0];
    const resolved = await resolveRules(
      tx,
      d.schoolId,
      en.class_id,
      local.date,
      prior?.rule_version_id,
    );
    if (!resolved.rule) {
      result.outcome = 'STORED_PENDING_RULES';
      return save();
    }
    const rules: RuleSet = ruleSchema.parse(resolved.rule.rules);
    const policyTime = trustedTime(
      refs[0] && Math.abs(Number(refs[0].skew_ms)) > rules.max_clock_skew_seconds * 1000
        ? { ...e, time_source: 'RTC_UNSYNCED' }
        : e,
      received,
      refs[0]?.boot_reference_time,
      rules.max_clock_skew_seconds,
    );
    if (
      policyTime.trust === 'SUSPECT' ||
      localParts(policyTime.effective, device.timezone).date !== local.date
    ) {
      await tx.query(
        "UPDATE attendance_events SET timestamp_trust='SUSPECT',effective_ts=$2 WHERE id=$1",
        [id, received],
      );
      result.outcome = 'QUARANTINED_TIMESTAMP';
      return save();
    }

    if (policyTime.effective.getTime() !== t.effective.getTime() || policyTime.trust !== t.trust) {
      t.effective = policyTime.effective;
      t.trust = policyTime.trust;
      await tx.query(
        'UPDATE attendance_events SET effective_ts=$2,timestamp_trust=$3 WHERE id=$1',
        [id, t.effective, t.trust],
      );
    }
    if (
      resolved.holiday ||
      (!resolved.weekendOverride &&
        rules.weekly_off.includes(local.weekday as RuleSet['weekly_off'][number]))
    ) {
      result.outcome = 'NO_SCHOOL_DAY';
      return save();
    }
    await tx.query(
      `INSERT INTO daily_attendance(school_id,student_id,attendance_date,class_id,academic_session_id,rule_version_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(school_id,student_id,attendance_date) DO NOTHING`,
      [
        d.schoolId,
        card.student_id,
        local.date,
        en.class_id,
        en.academic_session_id,
        resolved.rule.id,
      ],
    );
    const day = (
      await tx.query(
        'SELECT * FROM daily_attendance WHERE school_id=$1 AND student_id=$2 AND attendance_date=$3 FOR UPDATE',
        [d.schoolId, card.student_id, local.date],
      )
    ).rows[0];
    const lastAccepted: FoldEvent | undefined = day.last_applied_event_ts
      ? (
          await tx.query(
            'SELECT id,device_id,sequence_number,effective_ts,location_type,timestamp_trust,status FROM attendance_events WHERE school_id=$1 AND student_id=$2 AND effective_ts=$3 AND applied_to_daily ORDER BY device_id DESC,sequence_number DESC LIMIT 1',
            [d.schoolId, card.student_id, day.last_applied_event_ts],
          )
        ).rows[0]
      : undefined;
    const sameTime =
      lastAccepted && t.effective.getTime() === new Date(lastAccepted.effective_ts).getTime();
    const sortsEarlier =
      !!lastAccepted &&
      (t.effective.getTime() < new Date(lastAccepted.effective_ts).getTime() ||
        (sameTime &&
          (d.id.localeCompare(lastAccepted.device_id) < 0 ||
            (d.id === lastAccepted.device_id &&
              e.sequence_number < Number(lastAccepted.sequence_number)))));
    const replay = !lastAccepted || sortsEarlier || reprocess;
    const events: FoldEvent[] = replay
      ? ((
          await tx.query(
            "SELECT id,device_id,sequence_number,effective_ts,location_type,timestamp_trust,status FROM attendance_events WHERE school_id=$1 AND student_id=$2 AND effective_ts >= ($3::date::timestamp AT TIME ZONE $4) AND effective_ts < (($3::date+1)::timestamp AT TIME ZONE $4) AND status<>'REJECTED' AND (outcome IS NULL OR outcome<>'NO_SCHOOL_DAY')",
            [d.schoolId, card.student_id, local.date, device.timezone],
          )
        ).rows as FoldEvent[])
      : [
          {
            id,
            device_id: d.id,
            sequence_number: e.sequence_number,
            effective_ts: t.effective,
            location_type: device.location_type,
            timestamp_trust: t.trust,
            status: 'RECORDED',
          },
        ];
    const base = Object.fromEntries(
      Object.keys(emptyDay()).map((k) => [k, day[k]]),
    ) as unknown as DayState;
    const projection = fold(
        events,
        rules,
        device.timezone,
        replay ? undefined : base,
        replay ? undefined : lastAccepted,
      ),
      s = projection.state;
    if (
      day.manual_override ||
      (s.attendance_status === 'PENDING' && ['ABSENT', 'EXCUSED'].includes(day.attendance_status))
    )
      s.attendance_status = day.attendance_status;
    {
      const keys = Object.keys(s) as (keyof typeof s)[];
      await tx.query(
        `UPDATE daily_attendance SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(',')},rule_version_id=$${keys.length + 2},source=CASE WHEN manual_override THEN source ELSE 'NFC' END,version=version+1 WHERE id=$1`,
        [day.id, ...keys.map((k) => s[k]), resolved.rule.id],
      );
    }
    // Raw facts stay immutable. Processing outcomes may change under deterministic replay.
    for (const [eventId, outcome] of projection.outcomes)
      await tx.query('UPDATE attendance_events SET outcome=$2,applied_to_daily=$3 WHERE id=$1', [
        eventId,
        outcome,
        /^(ARRIVAL_|DEPARTURE_|REENTRY_|ACCEPTED_)/.test(outcome),
      ]);
    let queued = false;
    for (const n of projection.notifications) {
      const key = `${n.kind}:${d.schoolId}:${card.student_id}:${local.date}${n.episode ? `:${n.episode}` : ''}`;
      queued =
        (await queue(
          tx,
          d.schoolId,
          card.student_id,
          n.kind,
          key,
          {
            event_time: n.at.toISOString(),
            attendance_date: local.date,
            attendance_status: s.attendance_status,
            arrival_classification: s.arrival_classification,
          },
          n.eventId,
        )) || queued;
    }
    if (
      !day.manual_override &&
      day.attendance_status === 'ABSENT' &&
      s.first_arrival_at &&
      ['ON_TIME', 'LATE'].includes(s.arrival_classification || '')
    ) {
      queued =
        (await queue(
          tx,
          d.schoolId,
          card.student_id,
          'ATTENDANCE_CORRECTED',
          `ATTENDANCE_CORRECTED:${d.schoolId}:${card.student_id}:${local.date}:retraction`,
          {
            event_time: s.first_arrival_at.toISOString(),
            attendance_status: s.attendance_status,
            attendance_date: local.date,
          },
          id,
        )) || queued;
    }
    result = {
      ...result,
      outcome: projection.outcomes.get(id) || 'FLAGGED_OUTSIDE_WINDOW',
      attendance_status: day.manual_override ? day.attendance_status : s.attendance_status,
      movement_status: s.movement_status,
      notification_queued: queued,
    };
    return save();
  });
}
