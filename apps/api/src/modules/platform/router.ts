import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { uuid } from '@vidyalayaa/contracts';
import { platformTx, transaction, audit } from '../../lib/db.js';
import { platformOnly, permission } from '../../middleware/auth.js';
import { asyncRoute, ApiError, notFound } from '../../lib/errors.js';
import { secret, hash } from '../../lib/crypto.js';
export function platformRouter(platform: pg.Pool, api: pg.Pool) {
  const r = Router();
  r.use(platformOnly);
  r.get(
    '/schools',
    asyncRoute(async (_req, res) =>
      res.json(
        await platformTx(platform, res.locals.actor.id, async (tx) => ({
          data: (
            await tx.query(
              'SELECT s.*,p.name AS plan,sub.status AS subscription_status,sub.current_period_end,sub.grace_ends_at FROM schools s LEFT JOIN LATERAL(SELECT * FROM subscriptions WHERE school_id=s.id ORDER BY created_at DESC LIMIT 1) sub ON true LEFT JOIN subscription_plans p ON p.id=sub.plan_id ORDER BY s.name',
            )
          ).rows,
        })),
      ),
    ),
  );
  r.post(
    '/schools',
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        b = z
          .object({
            school_code: z.string().regex(/^[A-Z0-9_-]{3,32}$/),
            name: z.string().min(2).max(200),
            timezone: z.string().max(100),
            plan_code: z.enum(['BASIC', 'PROFESSIONAL', 'ENTERPRISE']),
            trial_ends_at: z.string().datetime(),
          })
          .strict()
          .parse(req.body);
      try {
        new Intl.DateTimeFormat('en', { timeZone: b.timezone }).format();
      } catch {
        throw new ApiError(422, 'INVALID_TIMEZONE', 'Use an IANA timezone.');
      }
      res.status(201).json(
        await platformTx(platform, a.id, async (tx) => {
          const school = (
            await tx.query(
              "INSERT INTO schools(school_code,name,timezone,status) VALUES($1,$2,$3,'ACTIVE') RETURNING *",
              [b.school_code, b.name, b.timezone],
            )
          ).rows[0];
          await tx.query(
            "INSERT INTO subscriptions(school_id,plan_id,status,current_period_end) SELECT $1,id,'TRIALING',$3 FROM subscription_plans WHERE code=$2",
            [school.id, b.plan_code, b.trial_ends_at],
          );
          return school;
        }),
      );
    }),
  );
  r.get(
    '/plans',
    asyncRoute(async (_req, res) =>
      res.json(
        await platformTx(platform, res.locals.actor.id, async (tx) => ({
          data: (await tx.query('SELECT * FROM subscription_plans ORDER BY code')).rows,
        })),
      ),
    ),
  );
  r.patch(
    '/schools/:id/subscription',
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        id = uuid.parse(req.params.id),
        b = z
          .object({
            plan_id: uuid.optional(),
            plan_code: z.enum(['BASIC', 'PROFESSIONAL', 'ENTERPRISE']).optional(),
            status: z.enum([
              'TRIALING',
              'ACTIVE',
              'PAST_DUE',
              'SUSPENDED_READONLY',
              'SUSPENDED',
              'CANCELLED',
              'EXPIRED',
            ]),
            current_period_end: z.string().datetime(),
            grace_ends_at: z.string().datetime().nullable().optional(),
            limit_overrides: z.record(z.number().int().nonnegative()).optional(),
            reason: z.string().min(5).max(1000),
          })
          .strict()
          .refine((x) => !!x.plan_id || !!x.plan_code, 'Choose a plan')
          .parse(req.body);
      res.json(
        await platformTx(platform, a.id, async (tx) => {
          const sub = (
            await tx.query(
              'SELECT * FROM subscriptions WHERE school_id=$1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE',
              [id],
            )
          ).rows[0];
          if (!sub) throw notFound();
          const row = (
            await tx.query(
              'UPDATE subscriptions SET plan_id=coalesce($2::uuid,(SELECT id FROM subscription_plans WHERE code=$7)),status=$3,current_period_end=$4,grace_ends_at=$5,limit_overrides=$6 WHERE id=$1 RETURNING *',
              [
                sub.id,
                b.plan_id || null,
                b.status,
                b.current_period_end,
                b.grace_ends_at || null,
                b.limit_overrides || null,
                b.plan_code || null,
              ],
            )
          ).rows[0];
          await tx.query(
            'INSERT INTO subscription_events(school_id,subscription_id,previous_status,new_status,reason,actor_id) VALUES($1,$2,$3,$4,$5,$6)',
            [id, sub.id, sub.status, b.status, b.reason, a.id],
          );
          return row;
        }),
      );
    }),
  );
  r.get(
    '/devices',
    asyncRoute(async (_req, res) =>
      res.json(
        await platformTx(platform, res.locals.actor.id, async (tx) => ({
          data: (
            await tx.query(
              'SELECT d.id,d.school_id,d.device_code,d.name,d.status,d.firmware_version,d.last_seen_at,d.pending_event_count,d.reader_status,d.rtc_status,s.name AS school_name FROM devices d JOIN schools s ON s.id=d.school_id ORDER BY d.created_at DESC',
            )
          ).rows,
        })),
      ),
    ),
  );
  r.post(
    '/devices',
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        b = z
          .object({
            school_id: uuid,
            device_code: z.string().regex(/^[A-Z0-9_-]{3,64}$/),
            name: z.string().min(2).max(100),
            hardware_serial: z.string().min(3).max(100),
          })
          .strict()
          .parse(req.body),
        credential = secret(),
        claim = secret();
      const row = await platformTx(platform, a.id, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          b.school_id + ':devices',
        ]);
        const plan = (
          await tx.query(
            'SELECT p.features,p.limits,s.limit_overrides FROM subscriptions s JOIN subscription_plans p ON p.id=s.plan_id WHERE school_id=$1 ORDER BY s.created_at DESC LIMIT 1',
            [b.school_id],
          )
        ).rows[0];
        const count = Number(
          (
            await tx.query(
              "SELECT count(*) FROM devices WHERE school_id=$1 AND status<>'REVOKED'",
              [b.school_id],
            )
          ).rows[0].count,
        );
        if (
          !plan?.features.nfc_attendance ||
          count >= Number(plan.limit_overrides?.max_devices ?? plan.limits.max_devices)
        )
          throw new ApiError(
            409,
            'PLAN_LIMIT_REACHED',
            'Device registration exceeds the school entitlement.',
          );
        const d = (
          await tx.query(
            'INSERT INTO devices(school_id,device_code,name,hardware_serial,claim_code_hash) VALUES($1,$2,$3,$4,$5) RETURNING id,device_code,status',
            [
              b.school_id,
              b.device_code,
              b.name,
              b.hardware_serial,
              Buffer.from(hash(claim), 'hex'),
            ],
          )
        ).rows[0];
        await tx.query(
          "INSERT INTO device_credentials(school_id,device_id,secret_hash,status) VALUES($1,$2,$3,'ACTIVE')",
          [b.school_id, d.id, Buffer.from(hash(credential), 'hex')],
        );
        return d;
      });
      res.setHeader('Cache-Control', 'no-store');
      res.status(201).json({
        ...row,
        device_secret: credential,
        claim_code: claim,
        notice:
          'Shown once. Provision securely; never put this credential in the browser application.',
      });
    }),
  );
  r.post(
    '/devices/:id/rotate',
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        id = uuid.parse(req.params.id),
        b = z
          .object({ reason: z.string().min(5).max(1000) })
          .strict()
          .parse(req.body),
        credential = secret();
      await platformTx(platform, a.id, async (tx) => {
        const d = (await tx.query('SELECT * FROM devices WHERE id=$1 FOR UPDATE', [id])).rows[0];
        if (!d) throw notFound();
        await tx.query(
          "UPDATE device_credentials SET status='REVOKED' WHERE device_id=$1 AND status='ROTATING_OUT'",
          [id],
        );
        await tx.query(
          "UPDATE device_credentials SET status='ROTATING_OUT',expires_at=now()+interval '24 hours' WHERE device_id=$1 AND status='ACTIVE'",
          [id],
        );
        await tx.query(
          "INSERT INTO device_credentials(school_id,device_id,secret_hash,status) VALUES($1,$2,$3,'ACTIVE')",
          [d.school_id, id, Buffer.from(hash(credential), 'hex')],
        );
      });
      res.setHeader('Cache-Control', 'no-store');
      res.json({ device_secret: credential, overlap_hours: 24, reason: b.reason });
    }),
  );
  r.post(
    '/devices/:id/revoke',
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        id = uuid.parse(req.params.id),
        b = z
          .object({ reason: z.string().min(5).max(1000) })
          .strict()
          .parse(req.body);
      await platformTx(platform, a.id, async (tx) => {
        if (
          !(
            await tx.query(
              "UPDATE devices SET status='REVOKED',revoked_at=now(),revoked_reason=$2 WHERE id=$1 RETURNING id",
              [id, b.reason],
            )
          ).rowCount
        )
          throw notFound();
        await tx.query("UPDATE device_credentials SET status='REVOKED' WHERE device_id=$1", [id]);
      });
      res.status(204).end();
    }),
  );
  r.get(
    '/support-grants',
    asyncRoute(async (_req, res) =>
      res.json(
        await platformTx(platform, res.locals.actor.id, async (tx) => ({
          data: (
            await tx.query('SELECT * FROM support_access_grants ORDER BY created_at DESC LIMIT 100')
          ).rows,
        })),
      ),
    ),
  );
  r.post(
    '/support-grants',
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        b = z
          .object({
            school_id: uuid,
            reason: z.string().min(10).max(1000),
            ticket_ref: z.string().min(3).max(100),
            scope: z.array(z.enum(['students', 'attendance', 'marks', 'fees'])).min(1),
            minutes: z.number().int().min(1).max(1440).default(60),
          })
          .strict()
          .parse(req.body);
      res
        .status(201)
        .json(
          await platformTx(
            platform,
            a.id,
            async (tx) =>
              (
                await tx.query(
                  'INSERT INTO support_access_grants(school_id,staff_user_id,reason,ticket_ref,scope,starts_at,expires_at) VALUES($1,$2,$3,$4,$5,now(),now()+make_interval(mins=>$6)) RETURNING *',
                  [b.school_id, a.id, b.reason, b.ticket_ref, JSON.stringify(b.scope), b.minutes],
                )
              ).rows[0],
          ),
        );
    }),
  );
  r.get(
    '/support-grants/:id/:feature',
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        id = uuid.parse(req.params.id),
        feature = z.enum(['students', 'attendance', 'marks', 'fees']).parse(req.params.feature);
      const grant = await platformTx(
        platform,
        a.id,
        async (tx) =>
          (
            await tx.query(
              'SELECT * FROM support_access_grants WHERE id=$1 AND staff_user_id=$2 AND approved_by IS NOT NULL AND starts_at<=now() AND expires_at>now() AND revoked_at IS NULL',
              [id, a.id],
            )
          ).rows[0],
      );
      if (!grant || !grant.scope.includes(feature)) throw notFound();
      const table = {
        students: 'students',
        attendance: 'daily_attendance',
        marks: 'marks',
        fees: 'fee_records',
      }[feature];
      const data = await transaction(
        api,
        { schoolId: grant.school_id, userId: a.id, actorType: 'SUPPORT' },
        async (tx) =>
          (
            await tx.query(
              `SELECT * FROM ${table} WHERE school_id=$1 ORDER BY created_at DESC LIMIT 100`,
              [grant.school_id],
            )
          ).rows,
        true,
      );
      await transaction(
        api,
        { schoolId: grant.school_id, userId: a.id, actorType: 'SUPPORT' },
        async (tx) => {
          for (const record of data)
            await tx.query(
              "INSERT INTO audit_logs(school_id,actor_type,actor_id,support_grant_id,action,entity_type,entity_id) VALUES($1,'SUPPORT',$2,$3,'support.read',$4,$5)",
              [grant.school_id, a.id, id, table, record.id],
            );
        },
      );
      res.json({ data });
    }),
  );
  return r;
}
export function supportApprovalRouter(pool: pg.Pool) {
  const r = Router();
  r.use(permission('users.manage'));
  r.get(
    '/',
    asyncRoute(async (_req, res) => {
      const a = res.locals.actor;
      res.json(
        await transaction(
          pool,
          a.context,
          async (tx) => ({
            data: (
              await tx.query(
                'SELECT id,reason,ticket_ref,scope,starts_at,expires_at,approved_by,revoked_at FROM support_access_grants WHERE school_id=$1 ORDER BY created_at DESC LIMIT 100',
                [a.context.schoolId],
              )
            ).rows,
          }),
          true,
        ),
      );
    }),
  );
  r.post(
    '/:id/decision',
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        id = uuid.parse(req.params.id),
        b = z.object({ approve: z.boolean() }).strict().parse(req.body);
      res.json(
        await transaction(pool, a.context, async (tx) => {
          const result = await tx.query(
            'UPDATE support_access_grants SET approved_by=CASE WHEN $3 THEN $4::uuid ELSE NULL END,revoked_at=CASE WHEN $3 THEN NULL ELSE now() END WHERE school_id=$1 AND id=$2 AND expires_at>now() RETURNING id,approved_by,revoked_at',
            [a.context.schoolId, id, b.approve, a.id],
          );
          if (!result.rowCount) throw notFound();
          await audit(
            tx,
            a.context.schoolId,
            a.id,
            'support.grant.decision',
            'support_access_grants',
            id,
          );
          return result.rows[0];
        }),
      );
    }),
  );
  return r;
}
