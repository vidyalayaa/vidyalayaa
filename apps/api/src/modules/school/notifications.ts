import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import {
  customNotificationSchema,
  defaultNotificationSettings,
  notificationSettingsSchema,
  uuid,
  type CustomNotificationInput,
} from '@vidyalayaa/contracts';
import { transaction, type Tx } from '../../lib/db.js';
import { asyncRoute, ApiError, notFound } from '../../lib/errors.js';
import { permission, type Actor } from '../../middleware/auth.js';
import { paged, cursorPage } from '../../lib/pagination.js';
import { hash } from '../../lib/crypto.js';

async function recipients(tx: Tx, b: CustomNotificationInput) {
  const rows = (await tx.query('SELECT * FROM app.notification_members()')).rows;
  const selected = rows.filter(
    (x) =>
      b.audience === 'ALL' ||
      (b.audience === 'ROLES' ? b.roles.includes(x.role) : b.user_ids.includes(x.user_id)),
  );
  if (b.audience === 'MEMBERS' && selected.length !== b.user_ids.length)
    throw new ApiError(422, 'INVALID_RECIPIENT', 'Choose active members of this school only.');
  if (!selected.length || selected.length > 5000)
    throw new ApiError(
      422,
      'INVALID_RECIPIENT',
      'Choose between 1 and 5,000 active school members.',
    );
  return {
    user_ids: selected.map((x) => x.user_id).sort(),
    recipients: selected.length,
    push_ready: selected.filter((x) => Number(x.push_devices) > 0).length,
    devices: selected.reduce((n, x) => n + Number(x.push_devices), 0),
  };
}
const summary = `SELECT o.id,o.kind,o.status,o.created_at,o.cancelled_at,o.last_error,o.payload-'request_hash' AS payload,
 (SELECT count(*)::int FROM notification_recipient_targets t WHERE t.school_id=o.school_id AND t.outbox_id=o.id) AS recipients,
 (SELECT count(*)::int FROM notification_deliveries d WHERE d.school_id=o.school_id AND d.outbox_id=o.id AND d.status='SENT') AS accepted,
 (SELECT count(*)::int FROM notification_deliveries d WHERE d.school_id=o.school_id AND d.outbox_id=o.id AND d.status IN ('FAILED','DEAD')) AS failed
 FROM notification_outbox o`;
export function notificationsRouter(
  pool: pg.Pool,
  writes: { requireWrite: (tx: Tx, a: Actor) => Promise<void> },
) {
  const r = Router();
  r.get(
    '/members',
    permission('notifications.manage'),
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        q = z
          .object({ search: z.string().max(200).default(''), role: z.string().max(30).default('') })
          .parse(req.query);
      res.json(
        await transaction(
          pool,
          a.context,
          (tx) =>
            paged(
              tx,
              `SELECT user_id,full_name,email,role,push_devices::int AS push_devices FROM app.notification_members() WHERE (full_name ILIKE $1 OR email ILIKE $1) AND ($2='' OR role=$2) ORDER BY full_name,user_id`,
              ['%' + q.search + '%', q.role],
              req.query,
            ),
          true,
        ),
      );
    }),
  );
  r.post(
    '/preview',
    permission('notifications.manage'),
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        b = customNotificationSchema.parse(req.body);
      res.json(await transaction(pool, a.context, (tx) => recipients(tx, b), true));
    }),
  );
  r.post(
    '/messages',
    permission('notifications.manage'),
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        b = customNotificationSchema.parse(req.body),
        key = req.get('Idempotency-Key');
      if (!key || !/^[a-zA-Z0-9:_-]{8,200}$/.test(key))
        throw new ApiError(422, 'INVALID_IDEMPOTENCY_KEY', 'A unique message key is required.');
      res.status(202).json(
        await transaction(pool, a.context, async (tx) => {
          await writes.requireWrite(tx, a);
          const audience = await recipients(tx, b);
          const fingerprint = hash(
            JSON.stringify({ title: b.title, body: b.body, user_ids: audience.user_ids }),
          );
          const id = (
            await tx.query('SELECT app.queue_custom_notification($1,$2,$3,$4,$5) AS id', [
              b.title,
              b.body,
              audience.user_ids,
              key,
              fingerprint,
            ])
          ).rows[0].id;
          return { id, status: 'QUEUED', ...audience };
        }),
      );
    }),
  );
  r.get(
    '/messages',
    permission('notifications.read'),
    asyncRoute(async (req, res) => {
      const a = res.locals.actor;
      if (!['school_admin', 'principal'].includes(a.active!.role))
        throw new ApiError(403, 'FORBIDDEN', 'School notification history is restricted.');
      const q = z
        .object({ kind: z.string().max(40).default(''), status: z.string().max(30).default('') })
        .parse(req.query);
      res.json(
        await transaction(
          pool,
          a.context,
          (tx) =>
            paged(
              tx,
              `${summary} WHERE o.school_id=$1 AND ($2='' OR o.kind=$2) AND ($3='' OR o.status=$3) ORDER BY o.created_at DESC,o.id DESC`,
              [a.context.schoolId, q.kind, q.status],
              req.query,
            ),
          true,
        ),
      );
    }),
  );
  r.get(
    '/messages/:id/deliveries',
    permission('notifications.read'),
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        id = uuid.parse(req.params.id);
      if (!['school_admin', 'principal'].includes(a.active!.role))
        throw new ApiError(403, 'FORBIDDEN', 'School notification history is restricted.');
      res.json(
        await transaction(
          pool,
          a.context,
          (tx) =>
            paged(
              tx,
              `SELECT d.id,d.channel,d.status,d.last_error,d.created_at,d.sent_at,u.full_name,u.email FROM notification_deliveries d LEFT JOIN users u ON u.id=d.recipient_user_id WHERE d.school_id=$1 AND d.outbox_id=$2 ORDER BY d.created_at,d.id`,
              [a.context.schoolId, id],
              req.query,
            ),
          true,
        ),
      );
    }),
  );
  r.post(
    '/messages/:id/cancel',
    permission('notifications.manage'),
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        id = uuid.parse(req.params.id),
        b = z
          .object({ reason: z.string().trim().min(5).max(1000) })
          .strict()
          .parse(req.body);
      await transaction(pool, a.context, async (tx) => {
        await writes.requireWrite(tx, a);
        if (
          !(await tx.query('SELECT app.cancel_school_notification($1,$2) AS ok', [id, b.reason]))
            .rows[0].ok
        )
          throw notFound();
      });
      res.status(204).end();
    }),
  );
  r.get(
    '/settings',
    permission('notifications.manage'),
    asyncRoute(async (_req, res) => {
      const a = res.locals.actor;
      res.json(
        await transaction(
          pool,
          a.context,
          async (tx) => {
            const row = (
              await tx.query(
                'SELECT enabled,channels,kinds,version FROM school_notification_settings WHERE school_id=$1',
                [a.context.schoolId],
              )
            ).rows[0];
            return row
              ? { ...row, kinds: { ...defaultNotificationSettings.kinds, ...row.kinds } }
              : defaultNotificationSettings;
          },
          true,
        ),
      );
    }),
  );
  r.put(
    '/settings',
    permission('notifications.manage'),
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        b = notificationSettingsSchema.parse(req.body);
      res.json(
        await transaction(pool, a.context, async (tx) => {
          await writes.requireWrite(tx, a);
          await tx.query(
            "SELECT pg_advisory_xact_lock(hashtextextended('notification-settings:'||$1,0))",
            [a.context.schoolId],
          );
          const old = (
            await tx.query(
              'SELECT version FROM school_notification_settings WHERE school_id=$1 FOR UPDATE',
              [a.context.schoolId],
            )
          ).rows[0];
          if ((old?.version ?? 0) !== b.version)
            throw new ApiError(409, 'VERSION_CONFLICT', 'Settings changed. Reload before saving.');
          return (
            await tx.query(
              `INSERT INTO school_notification_settings(school_id,enabled,channels,kinds,updated_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(school_id) DO UPDATE SET enabled=EXCLUDED.enabled,channels=EXCLUDED.channels,kinds=EXCLUDED.kinds,version=school_notification_settings.version+1,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING enabled,channels,kinds,version`,
              [
                a.context.schoolId,
                b.enabled,
                JSON.stringify(b.channels),
                JSON.stringify(b.kinds),
                a.id,
              ],
            )
          ).rows[0];
        }),
      );
    }),
  );
  // Custom inbox rows exist even when the recipient has not enabled browser push.
  r.get(
    '/',
    permission('notifications.read'),
    asyncRoute(async (req, res) => {
      const a = res.locals.actor;
      res.json(
        await transaction(
          pool,
          a.context,
          (tx) => {
            const select = `SELECT * FROM (
      SELECT d.id,d.channel,d.status,d.created_at,d.sent_at,d.last_error,o.kind,o.payload-'request_hash' AS payload FROM notification_deliveries d JOIN notification_outbox o ON o.school_id=d.school_id AND o.id=d.outbox_id WHERE d.school_id=$1 AND o.kind<>'CUSTOM'
      UNION ALL SELECT t.id,'PUSH',coalesce(d.status,CASE WHEN o.cancelled_at IS NOT NULL THEN 'SUPPRESSED' WHEN o.status='DEAD' THEN 'DEAD' WHEN o.status='COMPLETED' THEN 'SUPPRESSED' ELSE 'PENDING' END),o.created_at,d.sent_at,coalesce(d.last_error,o.last_error),o.kind,o.payload-'request_hash' FROM notification_recipient_targets t JOIN notification_outbox o ON o.school_id=t.school_id AND o.id=t.outbox_id LEFT JOIN notification_deliveries d ON d.school_id=t.school_id AND d.outbox_id=t.outbox_id AND d.recipient_user_id=t.user_id AND d.channel='PUSH' WHERE t.school_id=$1 AND t.user_id=$2
    ) inbox`;
            return req.query.cursor === '1'
              ? cursorPage(
                  tx,
                  select,
                  'WHERE true',
                  [a.context.schoolId, a.id],
                  'inbox.created_at',
                  'inbox.id',
                  'uuid',
                  req.query,
                )
              : paged(
                  tx,
                  select + ' ORDER BY created_at DESC,id DESC',
                  [a.context.schoolId, a.id],
                  req.query,
                );
          },
          true,
        ),
      );
    }),
  );
  return r;
}
