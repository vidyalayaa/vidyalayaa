import type pg from 'pg';
import { transaction } from '../../api/src/lib/db.js';
import { DeliveryError, deliver } from './providers.js';
export interface PushTarget {
  id: string;
  address: string;
}
export async function sendPushTargets(
  pool: pg.Pool,
  schoolId: string,
  deliveryId: string,
  targets: PushTarget[],
  message: string,
) {
  const ctx = { schoolId, actorType: 'SYSTEM' as const };
  let sent = false,
    retry: DeliveryError | undefined;
  for (const target of targets) {
    const row = await transaction(pool, ctx, async (tx) => {
      await tx.query(
        'INSERT INTO push_delivery_targets(school_id,delivery_id,token_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [schoolId, deliveryId, target.id],
      );
      return (
        await tx.query(
          'SELECT status,provider_message_id FROM push_delivery_targets WHERE school_id=$1 AND delivery_id=$2 AND token_id=$3',
          [schoolId, deliveryId, target.id],
        )
      ).rows[0];
    });
    if (row.status === 'SENT') {
      sent = true;
      continue;
    }
    if (row.status === 'DEAD') continue;
    try {
      const wait = Number(
        (
          await pool.query("SELECT app.take_provider_token('PUSH',$1,$2) AS wait", [
            Number(process.env.PUSH_RATE_PER_SECOND || 100),
            Number(process.env.PUSH_BURST || 100),
          ])
        ).rows[0].wait,
      );
      if (wait) throw new DeliveryError('PROVIDER_THROTTLED', false, wait);
      const providerId = await deliver(
        'PUSH',
        target.address,
        message,
        `${deliveryId}:${target.id}`,
      );
      sent = true;
      await transaction(pool, ctx, (tx) =>
        tx.query(
          "UPDATE push_delivery_targets SET status='SENT',provider_message_id=$4,last_error=NULL,updated_at=now() WHERE school_id=$1 AND delivery_id=$2 AND token_id=$3",
          [schoolId, deliveryId, target.id, providerId],
        ),
      );
    } catch (error) {
      const e = error instanceof DeliveryError ? error : new DeliveryError('PUSH_FAILED');
      if (!e.permanent) retry = e;
      await transaction(pool, ctx, async (tx) => {
        await tx.query(
          'UPDATE push_delivery_targets SET status=$4,last_error=$5,updated_at=now() WHERE school_id=$1 AND delivery_id=$2 AND token_id=$3',
          [schoolId, deliveryId, target.id, e.permanent ? 'DEAD' : 'PENDING', e.code],
        );
        if (e.permanent)
          await tx.query('UPDATE push_tokens SET is_active=false WHERE school_id=$1 AND id=$2', [
            schoolId,
            target.id,
          ]);
      });
    }
  }
  if (retry) throw retry;
  if (!sent) throw new DeliveryError('NO_VALID_PUSH_TARGETS', true);
  return 'push-targets-recorded';
}
