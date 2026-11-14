import type pg from 'pg';
import { transaction } from '../../api/src/lib/db.js';
import { localParts } from '../../api/src/modules/attendance/engine.js';
import { resolveRules, queue } from '../../api/src/modules/attendance/service.js';
import { ruleSchema, type SchoolTimings } from '@vidyalayaa/contracts';
export async function scheduledJobs(pool: pg.Pool, schoolId: string) {
  return transaction(pool, { schoolId, actorType: 'SYSTEM' }, async (tx) => {
    if (
      !(
        await tx.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked', [
          schoolId + ':scheduled',
        ])
      ).rows[0].locked
    )
      return;
    const school = (
        await tx.query(
          'SELECT *,app.reader_offline_minutes(settings) AS offline_minutes FROM schools WHERE id=$1',
          [schoolId],
        )
      ).rows[0],
      local = localParts(new Date(), school.timezone);
    const run = (
      await tx.query(
        "INSERT INTO job_runs(school_id,job_name,status) VALUES($1,'scheduled','RUNNING') RETURNING id",
        [schoolId],
      )
    ).rows[0].id;
    const offlineMs = school.offline_minutes * 60000;
    const devices = (
      await tx.query("SELECT * FROM devices WHERE school_id=$1 AND status='ACTIVE'", [schoolId])
    ).rows;
    const delayedDevice = devices.find(
      (d) =>
        !d.last_seen_at ||
        Date.now() - d.last_seen_at.getTime() > offlineMs ||
        d.pending_event_count > 0,
    );
    const delayed = !!delayedDevice;
    for (const d of devices)
      if (
        !d.last_seen_at ||
        Date.now() - d.last_seen_at.getTime() > offlineMs ||
        d.reader_status === 'FAIL' ||
        d.rtc_status === 'DRIFT' ||
        d.storage_used_pct >= 80
      ) {
        await tx.query(
          "INSERT INTO platform_notices(school_id,kind,source_ref) VALUES($1,'DEVICE_ALERT',$2) ON CONFLICT DO NOTHING",
          [schoolId, `${d.id}:${local.date}`],
        );
        for (const admin of (await tx.query('SELECT * FROM app.admin_contacts()')).rows)
          await queue(
            tx,
            schoolId,
            null,
            'DEVICE_ALERT',
            `DEVICE_ALERT:${d.id}:${admin.user_id}:${local.date}:${d.reader_status}:${d.rtc_status}`,
            {
              device_id: d.id,
              recipient_email: admin.email,
              recipient_user_id: admin.user_id,
              event_time: new Date().toISOString(),
            },
          );
      }
    {
      const timings: Pick<SchoolTimings, 'start_time' | 'days'> | undefined =
        school.settings.timetable;
      const weekday = new Date(local.date).getUTCDay() || 7;
      const currentTime = local.time.slice(0, 5);
      const minutes = (time: string) => {
        const [hours, mins] = time.split(':').map(Number);
        return hours * 60 + mins;
      };
      const enrolled = (
        await tx.query(
          `SELECT e.student_id,e.class_id,e.academic_session_id FROM enrollments e
           JOIN students s ON (s.school_id,s.id)=(e.school_id,e.student_id)
           JOIN classes c ON (c.school_id,c.id)=(e.school_id,e.class_id)
           JOIN academic_sessions ac ON (ac.school_id,ac.id)=(e.school_id,e.academic_session_id)
           WHERE e.school_id=$1 AND e.status='ACTIVE' AND e.starts_on<=$2::date
             AND (e.ends_on IS NULL OR e.ends_on>=$2::date) AND s.status='ACTIVE'
             AND ac.is_current AND ac.retired_at IS NULL AND c.retired_at IS NULL
             AND $2::date BETWEEN ac.starts_on AND ac.ends_on`,
          [schoolId, local.date],
        )
      ).rows;
      const byClass = new Map<string, Awaited<ReturnType<typeof resolveRules>>>();
      let hasDelayedAbsence = false;
      for (const en of enrolled) {
        let resolved = byClass.get(en.class_id);
        if (!resolved) {
          resolved = await resolveRules(tx, schoolId, en.class_id, local.date);
          byClass.set(en.class_id, resolved);
        }
        if (resolved.holiday) continue;
        const rule = resolved.rule ? ruleSchema.parse(resolved.rule.rules) : undefined;
        if (
          !resolved.weekendOverride &&
          (rule
            ? rule.weekly_off.includes(local.weekday as (typeof rule.weekly_off)[number])
            : !timings?.days.includes(weekday))
        )
          continue;
        const start =
          rule && (resolved.rule.class_id || resolved.rule.day_type !== 'REGULAR')
            ? rule.arrival.on_time_start
            : (timings?.start_time ?? rule?.arrival.on_time_start);
        if (!start) continue;
        const started = currentTime >= start;
        const finalizing =
          started &&
          (!rule ||
            (minutes(currentTime) >=
              minutes(rule.absent_cutoff) + rule.absent_finalize_grace_minutes &&
              (!delayed || currentTime >= '15:30')));
        await tx.query(
          "INSERT INTO daily_attendance(school_id,student_id,attendance_date,class_id,academic_session_id,rule_version_id,source) VALUES($1,$2,$3,$4,$5,$6,'SYSTEM') ON CONFLICT(school_id,student_id,attendance_date) DO NOTHING",
          [
            schoolId,
            en.student_id,
            local.date,
            en.class_id,
            en.academic_session_id,
            resolved.rule?.id ?? null,
          ],
        );
        if (!started) continue;
        const provisional = !!rule && (!finalizing || delayed);
        const changed = await tx.query(
          `UPDATE daily_attendance SET attendance_status='ABSENT',version=version+1,provisional=$4
           WHERE school_id=$1 AND student_id=$2 AND attendance_date=$3 AND class_id=$5
             AND first_arrival_at IS NULL AND NOT manual_override
             AND (attendance_status='PENDING' OR (attendance_status='ABSENT' AND provisional AND NOT $4))
           RETURNING id`,
          [schoolId, en.student_id, local.date, provisional, en.class_id],
        );
        if (!finalizing || !rule) continue;
        // An offline reader can leave an absence provisional through the end of the day.
        // Lock the record before queueing its deduplicated alert on the hard-limit pass.
        const absent =
          changed.rowCount ||
          (delayed &&
            (
              await tx.query(
                `SELECT id FROM daily_attendance
                 WHERE school_id=$1 AND student_id=$2 AND attendance_date=$3 AND class_id=$4
                   AND attendance_status='ABSENT' AND provisional
                   AND first_arrival_at IS NULL AND NOT manual_override FOR UPDATE`,
                [schoolId, en.student_id, local.date, en.class_id],
              )
            ).rowCount);
        if (!absent) continue;
        hasDelayedAbsence ||= delayed;
        if (rule.notify.absent)
          await queue(
            tx,
            schoolId,
            en.student_id,
            'STUDENT_ABSENT',
            `STUDENT_ABSENT:${schoolId}:${en.student_id}:${local.date}`,
            {
              attendance_date: local.date,
              event_time: new Date().toISOString(),
              provisional: delayed,
            },
          );
      }
      if (hasDelayedAbsence && delayedDevice)
        await tx.query("SELECT app.queue_device_security_alert('ABSENCE_PROVISIONAL',NULL,$1)", [
          delayedDevice.id,
        ]);
    }
    await tx.query(
      `INSERT INTO school_usage_snapshots(school_id,on_date,active_students,devices,notifications_sent)
      SELECT $1,$2,(SELECT count(*) FROM students WHERE school_id=$1 AND status='ACTIVE'),(SELECT count(*) FROM devices WHERE school_id=$1 AND status<>'REVOKED'),(SELECT count(*) FROM notification_deliveries WHERE school_id=$1 AND status='SENT' AND sent_at>=($2::date::timestamp AT TIME ZONE $3) AND sent_at<(($2::date+1)::timestamp AT TIME ZONE $3))
      ON CONFLICT(school_id,on_date) DO UPDATE SET active_students=EXCLUDED.active_students,devices=EXCLUDED.devices,notifications_sent=EXCLUDED.notifications_sent,recorded_at=now()`,
      [schoolId, local.date, school.timezone],
    );
    const sub = (
      await tx.query(
        'SELECT * FROM subscriptions WHERE school_id=$1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE',
        [schoolId],
      )
    ).rows[0];
    if (sub) {
      const now = Date.now(),
        end = sub.current_period_end.getTime(),
        days = (now - end) / 86400000;
      let status = sub.status;
      if (['ACTIVE', 'TRIALING'].includes(status) && now > end) status = 'PAST_DUE';
      if (['PAST_DUE', 'SUSPENDED_READONLY'].includes(status)) {
        const grace = sub.grace_ends_at?.getTime() ?? end + 15 * 86400000;
        if (now > grace + 30 * 86400000) status = 'SUSPENDED';
        else if (now > grace) status = 'SUSPENDED_READONLY';
      }
      if (status !== sub.status) {
        await tx.query(
          "INSERT INTO platform_notices(school_id,kind,source_ref) VALUES($1,'SUBSCRIPTION_UPDATE',$2) ON CONFLICT DO NOTHING",
          [schoolId, `${sub.id}:${status}:${local.date}`],
        );
        await tx.query(
          "UPDATE subscriptions SET status=$2,grace_ends_at=coalesce(grace_ends_at,current_period_end+interval '15 days') WHERE id=$1",
          [sub.id, status],
        );
        await tx.query(
          'INSERT INTO subscription_events(school_id,subscription_id,previous_status,new_status,reason) VALUES($1,$2,$3,$4,$5)',
          [schoolId, sub.id, sub.status, status, 'Scheduled lifecycle evaluation'],
        );
      }
      if (
        status !== sub.status ||
        (status === 'PAST_DUE' && [0, 3, 7, 12].includes(Math.floor(days)))
      ) {
        for (const admin of (await tx.query('SELECT * FROM app.admin_contacts()')).rows)
          await queue(
            tx,
            schoolId,
            null,
            'SUBSCRIPTION_UPDATE',
            `SUBSCRIPTION_UPDATE:${sub.id}:${status}:${admin.user_id}:${local.date}`,
            {
              recipient_email: admin.email,
              recipient_user_id: admin.user_id,
              subscription_status: status,
              event_time: new Date().toISOString(),
            },
          );
      }
    }
    await tx.query(
      "UPDATE push_tokens SET is_active=false WHERE school_id=$1 AND last_seen_at<now()-interval '60 days'",
      [schoolId],
    );
    await tx.query(
      "DELETE FROM device_heartbeats WHERE school_id=$1 AND received_at<now()-interval '30 days'",
      [schoolId],
    );
    await tx.query(
      "DELETE FROM device_logs WHERE school_id=$1 AND received_at<now()-interval '90 days'",
      [schoolId],
    );
    await tx.query("UPDATE job_runs SET status='COMPLETED',finished_at=now() WHERE id=$1", [run]);
  });
}
