import { Router, raw } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { hash } from '../../lib/crypto.js';
import { ApiError, asyncRoute } from '../../lib/errors.js';
export function billingRouter(pool: pg.Pool, secret?: string) {
  const r = Router();
  r.post(
    '/',
    raw({ type: 'application/json', limit: '32kb' }),
    asyncRoute(async (req, res) => {
      if (!secret)
        throw new ApiError(
          503,
          'BILLING_NOT_CONFIGURED',
          'Subscriptions are managed manually by the platform administrator.',
        );
      const timestamp = req.header('X-Webhook-Timestamp') || '',
        provided = req.header('X-Webhook-Signature') || '';
      const body = req.body as Buffer;
      if (
        !Buffer.isBuffer(body) ||
        !/^\d{10}$/.test(timestamp) ||
        Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 ||
        !/^[0-9a-f]{64}$/.test(provided)
      )
        throw new ApiError(401, 'INVALID_SIGNATURE', 'Invalid webhook signature.');
      const expected = createHmac('sha256', secret)
          .update(timestamp + '.')
          .update(body)
          .digest(),
        actual = Buffer.from(provided, 'hex');
      if (!timingSafeEqual(expected, actual))
        throw new ApiError(401, 'INVALID_SIGNATURE', 'Invalid webhook signature.');
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString());
      } catch {
        throw new ApiError(400, 'BAD_REQUEST', 'Invalid JSON.');
      }
      const b = z
        .object({
          id: z.string().min(8).max(200),
          school_id: z.guid(),
          status: z.enum(['ACTIVE', 'PAST_DUE', 'CANCELLED']),
          current_period_end: z.string().datetime(),
        })
        .strict()
        .parse(parsed);
      const result = await pool.query('SELECT app.apply_billing_event($1,$2,$3,$4,$5) AS applied', [
        b.id,
        hash(body.toString()),
        b.school_id,
        b.status,
        b.current_period_end,
      ]);
      res.json({ received: true, applied: result.rows[0].applied });
    }),
  );
  return r;
}
