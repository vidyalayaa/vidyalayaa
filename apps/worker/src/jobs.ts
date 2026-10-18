import type pg from 'pg';
import { transaction } from '../../api/src/lib/db.js';
import { localParts } from '../../api/src/modules/attendance/engine.js';
import { resolveRules, queue } from '../../api/src/modules/attendance/service.js';
import { ruleSchema } from '@vidyalayaa/contracts';
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
    const school = (await tx.query('SELECT * FROM schools WHERE id=$1', [schoolId])).rows[0],
      local = localParts(new Date(), school.timezone);
    const run = (
      await tx.query(
        "INSERT INTO job_runs(school_id,job_name,status) VALUES($1,'scheduled','RUNNING') RETURNING id",
        [schoolId],
      )
    ).rows[0].id;
    const devices = (
      await tx.query("SELECT * FROM devices WHERE school_id=$1 AND status='ACTIVE'", [schoolId])
    ).rows;
    const delayed = devices.some(
      (d) =>
        !d.last_seen_at ||
        Date.now() - d.last_seen_at.getTime() > 180000 ||
        d.pending_event_count > 0,
    );
    for (const d of devices)
      if (
        !d.last_seen_at ||
        Date.now() - d.last_seen_at.getTime() > 180000 ||
        d.reader_status === 'FAIL' ||
        d.rtc_status === 'DRIFT' ||
        d.storage_used_pct >= 80
      ) {
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
    if (local.time >= '00:05') {
      const enrolled = (
        await tx.query(
          "SELECT e.* FROM enrollments e JOIN students s ON s.school_id=e.school_id AND s.id=e.student_id WHERE e.school_id=$1 AND e.starts_on<=$2 AND (e.ends_on IS NULL OR e.ends_on>=$2) AND s.status='ACTIVE'",
          [schoolId, local.date],
        )
      ).rows;
      for (const en of enrolled) {
        const resolved = await resolveRules(tx, schoolId, en.class_id, local.date);
        if (!resolved.rule || resolved.holiday) continue;
        const rule = ruleSchema.parse(resolved.rule.rules);
        if (
          !resolved.weekendOverride &&
          rule.weekly_off.includes(local.weekday as (typeof rule.weekly_off)[number])
        )
          continue;
        await tx.query(
          "INSERT INTO daily_attendance(school_id,student_id,attendance_date,class_id,academic_session_id,rule_version_id,source) VALUES($1,$2,$3,$4,$5,$6,'SYSTEM') ON CONFLICT(school_id,student_id,attendance_date) DO NOTHING",
          [
            schoolId,
            en.student_id,
            local.date,
            en.class_id,
            en.academic_session_id,
            resolved.rule.id,
          ],
        );
        const [hh, mm] = rule.absent_cutoff.split(':').map(Number),
          now = Number(local.time.slice(0, 2)) * 60 + Number(local.time.slice(3, 5));
        if (
          now >= hh * 60 + mm + rule.absent_finalize_grace_minutes &&
          (!delayed || local.time >= '15:30')
        ) {
          const changed = await tx.query(
            "UPDATE daily_attendance SET attendance_status='ABSENT',version=version+1,provisional=$3 WHERE school_id=$1 AND student_id=$2 AND attendance_date=$4 AND attendance_status='PENDING' AND first_arrival_at IS NULL AND NOT manual_override RETURNING id",
            [schoolId, en.student_id, delayed, local.date],
          );
          if (changed.rowCount && rule.notify.absent)
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
      }
    }
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
