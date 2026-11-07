import { Router } from 'express';
import type pg from 'pg';
import {
  platformDailyNotificationSchema,
  platformNotificationSchema,
  uuid,
} from '@vidyalayaa/contracts';
import { platformTx } from '../../lib/db.js';
import { hash } from '../../lib/crypto.js';
import { ApiError, asyncRoute } from '../../lib/errors.js';
import { paged } from '../../lib/pagination.js';

function notificationKey(key: string | undefined) {
  if (!key || !/^[a-zA-Z0-9:_-]{8,200}$/.test(key))
    throw new ApiError(422, 'INVALID_IDEMPOTENCY_KEY', 'A unique message key is required.');
  return key;
}

export function platformNotificationsRouter(pool: pg.Pool) {
  const r = Router();
  r.get(
    '/daily',
    asyncRoute(async (req, res) => {
      res.json(
        await platformTx(pool, res.locals.actor.id, (tx) =>
          paged(
            tx,
            'SELECT * FROM app.platform_daily_notification_history() ORDER BY created_at DESC,id DESC',
            [],
            req.query,
          ),
        ),
      );
    }),
  );
  r.post(
    '/daily',
    asyncRoute(async (req, res) => {
      const input = platformDailyNotificationSchema.parse(req.body);
      const key = notificationKey(req.get('Idempotency-Key'));
      const id = await platformTx(
        pool,
        res.locals.actor.id,
        async (tx) =>
          (
            await tx.query('SELECT app.create_platform_daily_notification($1,$2,$3,$4,$5) AS id', [
              input.school_id,
              input.title,
              input.body,
              input.local_time,
              key,
            ])
          ).rows[0].id,
      );
      res.status(201).json({ id });
    }),
  );
  r.post(
    '/daily/:id/cancel',
    asyncRoute(async (req, res) => {
      const id = uuid.parse(req.params.id);
      const cancelled = await platformTx(
        pool,
        res.locals.actor.id,
        async (tx) =>
          (await tx.query('SELECT app.cancel_platform_daily_notification($1) AS cancelled', [id]))
            .rows[0].cancelled,
      );
      if (!cancelled)
        throw new ApiError(
          409,
          'NOTIFICATION_NOT_CANCELLABLE',
          'This daily schedule is unavailable or already stopped.',
        );
      res.status(204).end();
    }),
  );
  r.get(
    '/',
    asyncRoute(async (req, res) => {
      res.json(
        await platformTx(pool, res.locals.actor.id, (tx) =>
          paged(
            tx,
            'SELECT * FROM app.platform_notification_history() ORDER BY created_at DESC,id DESC',
            [],
            req.query,
          ),
        ),
      );
    }),
  );
  r.post(
    '/',
    asyncRoute(async (req, res) => {
      const input = platformNotificationSchema.parse(req.body);
      const key = notificationKey(req.get('Idempotency-Key'));
      const id = await platformTx(
        pool,
        res.locals.actor.id,
        async (tx) =>
          (
            await tx.query('SELECT app.queue_platform_notification($1,$2,$3,$4,$5,$6) AS id', [
              input.school_id,
              input.title,
              input.body,
              input.scheduled_at,
              key,
              hash(JSON.stringify(input)),
            ])
          ).rows[0].id,
      );
      res.status(202).json({ id, scheduled_at: input.scheduled_at });
    }),
  );
  r.post(
    '/:id/cancel',
    asyncRoute(async (req, res) => {
      const id = uuid.parse(req.params.id);
      const cancelled = await platformTx(
        pool,
        res.locals.actor.id,
        async (tx) =>
          (await tx.query('SELECT app.cancel_platform_notification($1) AS cancelled', [id])).rows[0]
            .cancelled,
      );
      if (!cancelled)
        throw new ApiError(
          409,
          'NOTIFICATION_NOT_CANCELLABLE',
          'This message is unavailable or has already started processing.',
        );
      res.status(204).end();
    }),
  );
  return r;
}
