import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { transaction } from '../../api/src/lib/db.js';
import { decrypt, hash } from '../../api/src/lib/crypto.js';
import { localParts } from '../../api/src/modules/attendance/engine.js';
import { deliver, DeliveryError } from './providers.js';
export const retryDelays = [30, 120, 600, 1800, 7200, 7200];
interface Job {
  id: string;
  school_id: string;
  student_id: string | null;
  kind: string;
  payload: Record<string, unknown>;
  created_at: Date;
  attempts: number;
  lease_token: string;
}
interface Recipient {
  id: string | null;
  user_id: string;
  email: string | null;
  phone: string | null;
}
export function inQuietHours(time: string, start: string | null, end: string | null) {
  if (!start || !end || start === end) return false;
  return start < end ? time >= start && time < end : time >= start || time < end;
}
export function messageFor(kind: string, payload: Record<string, unknown>, timezone: string) {
  const when = payload.event_time
    ? new Intl.DateTimeFormat('en-IN', {
        timeZone: timezone,
        hour: 'numeric',
        minute: '2-digit',
      }).format(new Date(String(payload.event_time)))
    : '';
  switch (kind) {
    case 'STUDENT_ARRIVED':
      return `Your child arrived at school at ${when}${payload.attendance_status === 'LATE' ? ' (late)' : ''}.`;
    case 'STUDENT_DEPARTED':
      return `Your child left school at ${when}.`;
    case 'STUDENT_ABSENT':
      return 'Your child has been marked absent today.';
    case 'ATTENDANCE_CORRECTED':
      return `Attendance was updated to ${String(payload.attendance_status).toLowerCase().replaceAll('_', ' ')}.`;
    case 'SUBSCRIPTION_UPDATE':
      return `Your school's subscription is ${String(payload.subscription_status).toLowerCase().replaceAll('_', ' ')}. Open Vidyalayaa to review billing and access.`;
    case 'FEE_REMINDER':
      return `A school fee balance of ${payload.currency} ${(Number(payload.amount_due) - Number(payload.amount_paid)).toFixed(2)} is due on ${String(payload.due_on).slice(0, 10)}. Open Vidyalayaa for details.`;
    case 'DEVICE_ALERT':
      return 'A school NFC device needs attention. Open the Vidyalayaa device dashboard for details.';
    case 'ANNOUNCEMENT':
      return `School announcement: ${String(payload.title || 'A new notice is available in Vidyalayaa.')}`;
    default:
      return 'A school update is available in Vidyalayaa.';
  }
}
export async function drainOutbox(pool: pg.Pool, schoolId: string, encryptionKey: string) {
  const ctx = { schoolId, actorType: 'SYSTEM' as const };
  const lease = randomUUID();
  const jobs = await transaction(
    pool,
    ctx,
    async (tx) =>
      (
        await tx.query<Job>(
          `WITH picked AS(SELECT id FROM notification_outbox WHERE school_id=$1 AND next_attempt_at<=now() AND (status='PENDING' OR (status='PROCESSING' AND locked_until<now())) ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT 5) UPDATE notification_outbox o SET status='PROCESSING',attempts=attempts+1,locked_until=now()+interval '5 minutes',lease_token=$2 FROM picked WHERE o.id=picked.id RETURNING o.*`,
          [schoolId, lease],
        )
      ).rows,
  );
  for (const job of jobs) {
    try {
      const context = await transaction(
        pool,
        ctx,
        async (tx) => {
          const school = (await tx.query('SELECT timezone FROM schools WHERE id=$1', [schoolId]))
            .rows[0];
          const sub = (
            await tx.query(
              'SELECT s.status,p.features FROM subscriptions s JOIN subscription_plans p ON p.id=s.plan_id WHERE s.school_id=$1 ORDER BY s.created_at DESC LIMIT 1',
              [schoolId],
            )
          ).rows[0];
          const recipients = (
            await tx.query<Recipient>(
              `SELECT DISTINCT p.id,p.user_id,p.email,p.phone FROM parents p JOIN student_parents sp ON sp.school_id=p.school_id AND sp.parent_id=p.id AND sp.status='ACTIVE' AND sp.can_receive_alerts JOIN students s ON s.school_id=sp.school_id AND s.id=sp.student_id WHERE p.school_id=$1 AND p.status='ACTIVE' AND ($2::uuid IS NULL OR sp.student_id=$2) AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM enrollments en WHERE en.school_id=s.school_id AND en.student_id=s.id AND en.class_id=$3 AND en.status='ACTIVE'))`,
              [schoolId, job.student_id, job.payload.class_id || null],
            )
          ).rows;
          return {
            timezone: school.timezone,
            sub,
            recipients: ['DEVICE_ALERT', 'SUBSCRIPTION_UPDATE'].includes(job.kind)
              ? [
                  {
                    id: null,
                    user_id: String(job.payload.recipient_user_id),
                    email: String(job.payload.recipient_email),
                    phone: null,
                  },
                ]
              : recipients,
          };
        },
        true,
      );
      let retry = false;
      let next = 30;
      for (const parent of context.recipients) {
        for (const channel of ['DEVICE_ALERT', 'SUBSCRIPTION_UPDATE'].includes(job.kind)
          ? ['EMAIL']
          : ['PUSH', 'EMAIL', 'SMS']) {
          const data = await transaction(pool, ctx, async (tx) => {
            const preference = (
              await tx.query(
                'SELECT * FROM notification_preferences WHERE school_id=$1 AND parent_id=$2 AND kind=$3 AND channel=$4',
                [schoolId, parent.id, job.kind, channel],
              )
            ).rows[0];
            const addresses =
              channel === 'EMAIL'
                ? parent.email
                  ? [parent.email]
                  : []
                : channel === 'SMS'
                  ? parent.phone
                    ? [parent.phone]
                    : []
                  : parent.user_id
                    ? (
                        await tx.query(
                          "SELECT token_encrypted FROM push_tokens WHERE school_id=$1 AND user_id=$2 AND is_active AND last_seen_at>now()-interval '60 days'",
                          [schoolId, parent.user_id],
                        )
                      ).rows.map((x) => decrypt(x.token_encrypted, encryptionKey))
                    : [];
            let status = 'PENDING';
            const eventTime = new Date(
              String(job.payload.event_time || job.created_at.toISOString()),
            );
            if (
              Date.now() - eventTime.getTime() >
              Number(process.env.NOTIFICATION_STALE_HOURS || 24) * 3600000
            )
              status = 'EXPIRED_STALE';
            else if (
              (!['DEVICE_ALERT', 'SUBSCRIPTION_UPDATE'].includes(job.kind) &&
                (([
                  'STUDENT_ARRIVED',
                  'STUDENT_DEPARTED',
                  'STUDENT_ABSENT',
                  'ATTENDANCE_CORRECTED',
                ].includes(job.kind) &&
                  !context.sub?.features.parent_alerts) ||
                  !['TRIALING', 'ACTIVE', 'PAST_DUE'].includes(context.sub?.status))) ||
              !addresses.length ||
              !(preference?.enabled ?? channel !== 'SMS') ||
              inQuietHours(
                localParts(new Date(), context.timezone).time,
                preference?.quiet_start,
                preference?.quiet_end,
              )
            )
              status = 'SUPPRESSED';
            const cap = Number(
              (
                await tx.query(
                  "SELECT count(DISTINCT d.outbox_id) FROM notification_deliveries d JOIN notification_outbox o ON o.school_id=d.school_id AND o.id=d.outbox_id WHERE d.school_id=$1 AND d.parent_id=$2 AND d.status='SENT' AND o.student_id IS NOT DISTINCT FROM $3::uuid AND d.outbox_id<>$4 AND d.created_at>=((now() AT TIME ZONE $5)::date::timestamp AT TIME ZONE $5)",
                  [schoolId, parent.id, job.student_id, job.id, context.timezone],
                )
              ).rows[0].count,
            );
            if (cap >= Number(process.env.NOTIFICATION_DAILY_CAP || 8)) status = 'SUPPRESSED';
            const inserted = await tx.query(
              'INSERT INTO notification_deliveries(school_id,outbox_id,parent_id,channel,address_hash,status) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(school_id,outbox_id,parent_id,channel) DO NOTHING RETURNING *',
              [
                schoolId,
                job.id,
                parent.id,
                channel,
                addresses[0] ? hash(addresses[0]) : null,
                status,
              ],
            );
            const delivery =
              inserted.rows[0] ||
              (
                await tx.query(
                  'SELECT * FROM notification_deliveries WHERE school_id=$1 AND outbox_id=$2 AND parent_id IS NOT DISTINCT FROM $3::uuid AND channel=$4',
                  [schoolId, job.id, parent.id, channel],
                )
              ).rows[0];
            if (status !== 'PENDING' && ['PENDING', 'FAILED'].includes(delivery.status)) {
              await tx.query('UPDATE notification_deliveries SET status=$2 WHERE id=$1', [
                delivery.id,
                status,
              ]);
              delivery.status = status;
            }
            return { addresses, delivery };
          });
          const delivery = data.delivery;
          if (!['PENDING', 'FAILED'].includes(delivery.status)) continue;
          // The lease is refreshed before every provider call. Providers receive delivery.id for idempotency.
          const own = await transaction(pool, ctx, (tx) =>
            tx.query(
              "UPDATE notification_outbox SET locked_until=now()+interval '5 minutes' WHERE id=$1 AND lease_token=$2 AND status='PROCESSING' RETURNING id",
              [job.id, lease],
            ),
          );
          if (!own.rowCount) break;
          const attempt = delivery.attempts + 1;
          try {
            let providerId = '';
            for (const address of data.addresses)
              providerId = await deliver(
                channel,
                address,
                messageFor(job.kind, job.payload, context.timezone),
                delivery.id,
              );
            await transaction(pool, ctx, async (tx) => {
              await tx.query(
                "UPDATE notification_deliveries SET status='SENT',attempts=$2,provider_message_id=$3,sent_at=now(),last_error=NULL WHERE id=$1",
                [delivery.id, attempt, providerId],
              );
              await tx.query(
                "INSERT INTO notification_attempts(school_id,delivery_id,attempt,status,provider_message_id) VALUES($1,$2,$3,'SENT',$4) ON CONFLICT DO NOTHING",
                [schoolId, delivery.id, attempt, providerId],
              );
            });
          } catch (error) {
            const e =
              error instanceof DeliveryError ? error : new DeliveryError('PROVIDER_UNAVAILABLE');
            const dead =
              e.permanent ||
              attempt >= 6 ||
              (['PUSH', 'SMS'].includes(channel) &&
                Date.now() - job.created_at.getTime() > 7200000);
            const delay = e.retryAfter || retryDelays[Math.min(attempt - 1, 5)];
            next = Math.max(next, delay);
            retry = retry || !dead;
            await transaction(pool, ctx, async (tx) => {
              await tx.query(
                'UPDATE notification_deliveries SET status=$2,attempts=$3,last_error=$4,next_attempt_at=now()+make_interval(secs=>$5) WHERE id=$1',
                [delivery.id, dead ? 'DEAD' : 'FAILED', attempt, e.code, delay],
              );
              await tx.query(
                'INSERT INTO notification_attempts(school_id,delivery_id,attempt,status,error_code) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
                [schoolId, delivery.id, attempt, dead ? 'DEAD' : 'FAILED', e.code],
              );
              if (channel === 'PUSH' && e.permanent && parent.user_id)
                await tx.query(
                  'UPDATE push_tokens SET is_active=false WHERE school_id=$1 AND user_id=$2',
                  [schoolId, parent.user_id],
                );
            });
          }
        }
      }
      await transaction(pool, ctx, async (tx) => {
        const dead =
          Number(
            (
              await tx.query(
                "SELECT count(*) FROM notification_deliveries WHERE outbox_id=$1 AND status='DEAD'",
                [job.id],
              )
            ).rows[0].count,
          ) > 0;
        await tx.query(
          "UPDATE notification_outbox SET status=$3,locked_until=NULL,completed_at=CASE WHEN $3 IN ('COMPLETED','DEAD') THEN now() ELSE NULL END,next_attempt_at=now()+make_interval(secs=>$4) WHERE id=$1 AND lease_token=$2",
          [job.id, lease, retry ? 'PENDING' : dead ? 'DEAD' : 'COMPLETED', next],
        );
        if (dead)
          console.error(
            JSON.stringify({
              level: 'error',
              code: 'NOTIFICATION_DEAD',
              school_id: schoolId,
              outbox_id: job.id,
            }),
          );
      });
    } catch {
      await transaction(pool, ctx, (tx) =>
        tx.query(
          "UPDATE notification_outbox SET status=CASE WHEN attempts>=6 THEN 'DEAD' ELSE 'PENDING' END,locked_until=NULL,next_attempt_at=now()+interval '30 seconds',last_error='WORKER_PROCESSING_FAILED' WHERE id=$1 AND lease_token=$2",
          [job.id, lease],
        ),
      );
    }
  }
  return jobs.length;
}
