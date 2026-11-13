import { Router } from 'express';
import { platformAuditSnapshot } from './audit.js';
import { schoolProfileRouter } from '../school-profile/router.js';
import { platformNotificationsRouter } from './notifications.js';
import { platformSchoolDeletionRouter, requireDeletionVerification } from './school-deletion.js';
import type pg from 'pg';
import { z } from 'zod';
import {
  uuid,
  firstAdminSchema,
  supportResponseSchema,
  schoolCreateSchema,
  schoolProfileDetailsSchema,
} from '@vidyalayaa/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Config } from '../../lib/config.js';
import { inviteMember, invitationError } from '../identity/invitations.js';
import { platformTx, transaction, audit, lockSchoolLifecycle } from '../../lib/db.js';
import { platformOnly, permission } from '../../middleware/auth.js';
import { asyncRoute, ApiError, notFound } from '../../lib/errors.js';
import { secret, hash } from '../../lib/crypto.js';
import { paged } from '../../lib/pagination.js';
import { academicFilters, cohortData } from '../school/academic-intelligence.js';
export function platformRouter(
  platform: pg.Pool,
  api: pg.Pool,
  auth: SupabaseClient,
  config: Config,
) {
  const r = Router();
  r.use(platformOnly);
  r.use(platformSchoolDeletionRouter(platform));
  r.use('/notifications', platformNotificationsRouter(platform));
  r.use('/schools/:schoolId/profile', schoolProfileRouter(platform, auth));
  r.get(
    '/audit',
    asyncRoute(async (req, res) => {
      const page = await platformTx(platform, res.locals.actor.id, (tx) =>
        paged(
          tx,
          "SELECT id,occurred_at,actor_type,actor_id,action,entity_type,entity_id,request_id,before,after,after->>'reason' AS reason FROM audit_logs WHERE (school_id IS NULL OR entity_type IN ('schools','devices','subscriptions','subscription_plans','support_access_grants','authentication','device_ota_assignments')) ORDER BY occurred_at DESC,id DESC",
          [],
          req.query,
        ),
      );
      res.json({
        ...page,
        data: page.data.map((row) => ({
          ...row,
          before: platformAuditSnapshot(String(row.entity_type), row.before),
          after: platformAuditSnapshot(String(row.entity_type), row.after),
        })),
      });
    }),
  );

  r.get(
    '/support-requests',
    asyncRoute(async (req, res) =>
      res.json(
        await platformTx(platform, res.locals.actor.id, (tx) =>
          paged(
            tx,
            'SELECT t.*,s.name AS school_name FROM support_requests t JOIN schools s ON s.id=t.school_id ORDER BY t.updated_at DESC,t.id',
            [],
            req.query,
          ),
        ),
      ),
    ),
  );
  r.patch(
    '/support-requests/:id',
    asyncRoute(async (req, res) => {
      const id = uuid.parse(req.params.id),
        b = supportResponseSchema.parse(req.body);
      await platformTx(platform, res.locals.actor.id, async (tx) => {
        const row = await tx.query(
          'UPDATE support_requests SET status=$2,response=$3,responded_by=$4 WHERE id=$1 RETURNING id',
          [id, b.status, b.response, res.locals.actor.id],
        );
        if (!row.rowCount) throw notFound();
      });
      res.status(204).end();
    }),
  );
  r.get(
    '/notices',
    asyncRoute(async (req, res) =>
      res.json(
        await platformTx(platform, res.locals.actor.id, (tx) =>
          paged(
            tx,
            'SELECT n.id,n.school_id,s.name AS school_name,n.kind,n.created_at FROM platform_notices n JOIN schools s ON s.id=n.school_id ORDER BY n.created_at DESC,n.id',
            [],
            req.query,
          ),
        ),
      ),
    ),
  );
  r.get(
    '/offboarding',
    asyncRoute(async (req, res) =>
      res.json(
        await platformTx(platform, res.locals.actor.id, (tx) =>
          paged(
            tx,
            `SELECT o.*,s.name AS school_name,s.timezone,EXISTS(SELECT FROM school_exports e WHERE e.school_id=o.school_id AND e.status='COMPLETED' AND e.snapshot_at>=o.closed_at) AS final_export_ready FROM school_offboarding o JOIN schools s ON s.id=o.school_id ORDER BY o.created_at DESC,o.id`,
            [],
            req.query,
          ),
        ),
      ),
    ),
  );
  r.post(
    '/schools/:id/offboarding',
    asyncRoute(async (req, res) => {
      const id = uuid.parse(req.params.id),
        b = z
          .object({
            policy_ref: z.string().min(5).max(200),
            reason: z.string().min(10).max(2000),
            export_until: z.string().datetime(),
            delete_after: z.string().datetime(),
          })
          .strict()
          .refine(
            (v) =>
              new Date(v.export_until).getTime() > Date.now() + 86400000 &&
              v.delete_after >= v.export_until,
            'Allow at least one day for export, then the approved retention period.',
          )
          .parse(req.body);
      const result = await platformTx(
        platform,
        res.locals.actor.id,
        async (tx) =>
          (
            await tx.query(
              'INSERT INTO school_offboarding(school_id,requested_by,policy_ref,reason,export_until,delete_after) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,status',
              [id, res.locals.actor.id, b.policy_ref, b.reason, b.export_until, b.delete_after],
            )
          ).rows[0],
      );
      res.status(201).json(result);
    }),
  );
  r.post(
    '/offboarding/:id/close',
    asyncRoute(async (req, res) => {
      const id = uuid.parse(req.params.id);
      z.object({ confirm: z.literal('CLOSE_SCHOOL') })
        .strict()
        .parse(req.body);
      await platformTx(platform, res.locals.actor.id, async (tx) => {
        const job = (
          await tx.query('SELECT permanent,school_id FROM school_offboarding WHERE id=$1', [id])
        ).rows[0];
        if (!job) throw notFound();
        if (job.permanent) {
          requireDeletionVerification(res.locals.actor);
          await lockSchoolLifecycle(tx, job.school_id, true);
          await tx.query(
            `UPDATE school_offboarding
             SET delete_after=delete_after+greatest(interval '0',now()+interval '24 hours'-export_until),
                 export_until=greatest(export_until,now()+interval '24 hours')
             WHERE id=$1 AND status='APPROVED'`,
            [id],
          );
        }
        await tx.query('SELECT app.close_approved_school($1)', [id]);
      });
      res.status(204).end();
    }),
  );
  r.post(
    '/offboarding/:id/hold',
    asyncRoute(async (req, res) => {
      const id = uuid.parse(req.params.id),
        b = z
          .object({
            enabled: z.boolean(),
            reason: z.string().min(10).max(2000),
            policy_ref: z.string().min(5).max(200),
          })
          .strict()
          .parse(req.body);
      await platformTx(platform, res.locals.actor.id, async (tx) => {
        const job = (
          await tx.query(
            'SELECT permanent,irreversible_at FROM school_offboarding WHERE id=$1 FOR UPDATE',
            [id],
          )
        ).rows[0];
        if (!job) throw notFound();
        if (job.permanent) requireDeletionVerification(res.locals.actor);
        if (job.irreversible_at)
          throw new ApiError(409, 'DELETION_IRREVERSIBLE', 'Permanent deletion has already begun.');
        const row = await tx.query(
          "UPDATE school_offboarding SET legal_hold=$2,reason=reason||E'\nLegal hold decision: '||$3 WHERE id=$1 AND policy_ref=$4 AND status NOT IN ('PURGED','CANCELLED') RETURNING id",
          [id, b.enabled, b.reason, b.policy_ref],
        );
        if (!row.rowCount) throw notFound();
      });
      res.status(204).end();
    }),
  );
  r.post(
    '/offboarding/:id/purge',
    asyncRoute(async (req, res) => {
      const id = uuid.parse(req.params.id),
        b = z
          .object({
            confirm: z.literal('DELETE_SCHOOL_DATA'),
            policy_ref: z.string().min(5).max(200),
            reason: z.string().min(10).max(2000),
          })
          .strict()
          .parse(req.body);
      await platformTx(platform, res.locals.actor.id, async (tx) => {
        const row = await tx.query(
          "UPDATE school_offboarding SET status='PURGE_REQUESTED',purge_requested_by=$2,reason=reason||E'\nPurge request: '||$4 WHERE id=$1 AND NOT permanent AND status='CLOSED' AND policy_ref=$3 AND legal_hold=false AND delete_after<=now() AND export_until<=now() RETURNING id",
          [id, res.locals.actor.id, b.policy_ref, b.reason],
        );
        if (!row.rowCount)
          throw new ApiError(
            409,
            'PURGE_NOT_APPROVED',
            'The export/retention window, school approval and legal hold must be resolved first.',
          );
      });
      res.status(202).json({ status: 'PURGE_REQUESTED' });
    }),
  );
  r.get(
    '/organizations',
    asyncRoute(async (req, res) =>
      res.json(
        await platformTx(platform, res.locals.actor.id, (tx) =>
          paged(
            tx,
            'SELECT id,name,created_at FROM organizations WHERE name ILIKE $1 ORDER BY name,id',
            [`%${typeof req.query.search === 'string' ? req.query.search : ''}%`],
            req.query,
          ),
        ),
      ),
    ),
  );
  r.post(
    '/organizations',
    asyncRoute(async (req, res) => {
      const b = z
        .object({ name: z.string().trim().min(2).max(200) })
        .strict()
        .parse(req.body);
      res
        .status(201)
        .json(
          await platformTx(
            platform,
            res.locals.actor.id,
            async (tx) =>
              (
                await tx.query('INSERT INTO organizations(name) VALUES($1) RETURNING id,name', [
                  b.name,
                ])
              ).rows[0],
          ),
        );
    }),
  );
  r.patch(
    '/schools/:id/organization',
    asyncRoute(async (req, res) => {
      const id = uuid.parse(req.params.id),
        b = z
          .object({ organization_id: uuid.nullable(), reason: z.string().min(5).max(1000) })
          .strict()
          .parse(req.body);
      await platformTx(platform, res.locals.actor.id, (tx) =>
        tx.query('SELECT app.set_school_organization($1,$2,$3)', [id, b.organization_id, b.reason]),
      );
      res.status(204).end();
    }),
  );
  r.get(
    '/usage',
    asyncRoute(async (req, res) =>
      res.json(
        await platformTx(platform, res.locals.actor.id, (tx) =>
          paged(
            tx,
            'SELECT u.*,s.name AS school_name FROM school_usage_snapshots u JOIN schools s ON s.id=u.school_id ORDER BY u.on_date DESC,u.school_id',
            [],
            req.query,
          ),
        ),
      ),
    ),
  );
  r.get(
    '/operations',
    asyncRoute(async (_req, res) =>
      res.json(
        await platformTx(platform, res.locals.actor.id, async (tx) => ({
          metrics: (await tx.query('SELECT app.platform_operations() AS metrics')).rows[0].metrics,
          workers: (
            await tx.query(
              `SELECT id,worker_name,last_seen_at,last_success_at,state,last_error_code,
                      true AS alive,
                      state='RUNNING' AND coalesce(last_success_at>now()-interval '5 minutes',false) AS ready
                 FROM worker_instances
                WHERE state<>'STOPPING' AND last_seen_at>now()-interval '90 seconds'
                ORDER BY last_seen_at DESC,id LIMIT 20`,
            )
          ).rows,
          server_time: new Date().toISOString(),
        })),
      ),
    ),
  );
  r.get(
    '/schools',
    asyncRoute(async (req, res) =>
      res.json(
        await platformTx(platform, res.locals.actor.id, (tx) =>
          paged(
            tx,
            'SELECT s.*,app.platform_bootstrap_status(s.id) AS admin_onboarding,p.name AS plan,p.code AS plan_code,sub.plan_id,sub.status AS subscription_status,sub.current_period_end,sub.grace_ends_at,sub.limit_overrides,sub.billing_ref,sub.export_until FROM schools s LEFT JOIN LATERAL(SELECT * FROM subscriptions WHERE school_id=s.id ORDER BY created_at DESC LIMIT 1) sub ON true LEFT JOIN subscription_plans p ON p.id=sub.plan_id WHERE s.name ILIKE $1 OR s.school_code ILIKE $1 ORDER BY s.name,s.id',
            [`%${typeof req.query.search === 'string' ? req.query.search : ''}%`],
            req.query,
          ),
        ),
      ),
    ),
  );
  r.post(
    '/schools/:id/administrator-invitation',
    asyncRoute(async (req, res) => {
      const school_id = uuid.parse(req.params.id),
        input = firstAdminSchema.parse(req.body);
      res
        .status(201)
        .json(
          await inviteMember(
            platform,
            res.locals.actor.context,
            auth,
            { school_id, email: input.email, full_name: input.full_name, role: 'school_admin' },
            config.WEB_ORIGINS.split(',')[0].trim() + '/auth/callback',
            input.resend,
          ),
        );
    }),
  );
  r.post(
    '/schools/:id/administrator-invitation/:invitation/cancel',
    asyncRoute(async (req, res) => {
      const sid = uuid.parse(req.params.id),
        iid = uuid.parse(req.params.invitation);
      try {
        await platformTx(platform, res.locals.actor.id, async (tx) => {
          const state = (await tx.query('SELECT app.platform_bootstrap_status($1) AS state', [sid]))
            .rows[0].state;
          if (state.invitation_id !== iid) throw notFound();
          await tx.query('SELECT app.cancel_school_invitation($1)', [iid]);
        });
      } catch (error) {
        invitationError(error);
      }
      res.status(204).end();
    }),
  );
  r.post(
    '/schools',
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        b = schoolCreateSchema.parse(req.body);
      try {
        new Intl.DateTimeFormat('en', { timeZone: b.timezone }).format();
      } catch {
        throw new ApiError(422, 'INVALID_TIMEZONE', 'Use an IANA timezone.');
      }
      res.status(201).json(
        await platformTx(platform, a.id, async (tx) => {
          const plan = (
            await tx.query(
              'SELECT id FROM subscription_plans WHERE code=$1 AND is_active FOR SHARE',
              [b.plan_code],
            )
          ).rows[0];
          if (!plan)
            throw new ApiError(422, 'PLAN_UNAVAILABLE', 'Choose an available subscription plan.');
          const school = (
            await tx.query(
              "INSERT INTO schools(school_code,name,timezone,status,profile) VALUES($1,$2,$3,'ACTIVE',$4) RETURNING *",
              [
                b.school_code,
                b.name,
                b.timezone,
                schoolProfileDetailsSchema.parse({
                  email: b.email,
                  phone: b.phone,
                  address_line1: b.address_line1,
                  city: b.city,
                  state: b.state,
                  postal_code: b.postal_code,
                  country: b.country,
                }),
              ],
            )
          ).rows[0];
          await tx.query(
            "INSERT INTO subscriptions(school_id,plan_id,status,current_period_end) VALUES($1,$2,'TRIALING',$3)",
            [school.id, plan.id, b.trial_ends_at],
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
    '/plans/:id',
    asyncRoute(async (req, res) => {
      const id = uuid.parse(req.params.id),
        b = z
          .object({
            name: z.string().trim().min(2).max(100),
            features: z.record(z.string(), z.boolean()),
            limits: z.record(z.string(), z.number().int().min(0).max(100000000)),
            is_active: z.boolean(),
            reason: z.string().min(5).max(1000),
          })
          .strict()
          .parse(req.body);
      res.json(
        await platformTx(platform, res.locals.actor.id, async (tx) => {
          const old = (
            await tx.query('SELECT * FROM subscription_plans WHERE id=$1 FOR UPDATE', [id])
          ).rows[0];
          if (!old) throw notFound();
          if (
            Object.keys(b.features).some((k) => !(k in old.features)) ||
            Object.keys(b.limits).some((k) => !(k in old.limits)) ||
            Object.keys(old.features).some((k) => !(k in b.features)) ||
            Object.keys(old.limits).some((k) => !(k in b.limits))
          )
            throw new ApiError(
              422,
              'PLAN_KEYS_REQUIRED',
              'Keep the defined feature and limit keys.',
            );
          const row = (
            await tx.query(
              'UPDATE subscription_plans SET name=$2,features=$3,limits=$4,is_active=$5 WHERE id=$1 RETURNING *',
              [id, b.name, JSON.stringify(b.features), JSON.stringify(b.limits), b.is_active],
            )
          ).rows[0];
          await tx.query(
            "INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,before,after) VALUES('USER',$1,'plan.update','subscription_plans',$2,$3,$4)",
            [
              res.locals.actor.id,
              id,
              JSON.stringify({ features: old.features, limits: old.limits }),
              JSON.stringify({ reason: b.reason, features: b.features, limits: b.limits }),
            ],
          );
          return row;
        }),
      );
    }),
  );
  r.patch(
    '/schools/:id/subscription',
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        id = uuid.parse(req.params.id),
        b = z
          .object({
            billing_ref: z.string().trim().min(3).max(200).nullable().optional(),
            export_until: z.string().datetime().nullable().optional(),
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
            limit_overrides: z
              .record(z.string(), z.number().int().min(0).max(100000000))
              .optional(),
            reason: z.string().min(5).max(1000),
          })
          .strict()
          .refine((x) => !!x.plan_id || !!x.plan_code, 'Choose a plan')
          .parse(req.body);
      res.json(
        await platformTx(platform, a.id, async (tx) => {
          // Serialize first-time setup on the school: there may be no subscription
          // row yet for SELECT FOR UPDATE to lock. RLS still scopes platform access.
          const school = (await tx.query('SELECT id FROM schools WHERE id=$1 FOR UPDATE', [id]))
            .rows[0];
          if (!school) throw notFound();
          const sub = (
            await tx.query(
              'SELECT * FROM subscriptions WHERE school_id=$1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE',
              [id],
            )
          ).rows[0];
          const plan = (
            await tx.query(
              'SELECT id,limits,is_active FROM subscription_plans WHERE ($1::uuid IS NOT NULL AND id=$1) OR ($1::uuid IS NULL AND code=$2) FOR SHARE',
              [b.plan_id || null, b.plan_code || null],
            )
          ).rows[0];
          if (!plan || (!plan.is_active && plan.id !== sub?.plan_id))
            throw new ApiError(422, 'PLAN_UNAVAILABLE', 'Choose an available subscription plan.');
          if (
            b.limit_overrides &&
            Object.keys(b.limit_overrides).some((key) => !(key in plan.limits))
          )
            throw new ApiError(422, 'INVALID_LIMIT', 'Choose a limit defined by this plan.');
          const exportUntil =
            b.export_until === undefined ? (sub?.export_until ?? null) : b.export_until;
          if (['SUSPENDED', 'CANCELLED', 'EXPIRED'].includes(b.status) && !exportUntil)
            throw new ApiError(
              422,
              'EXPORT_WINDOW_REQUIRED',
              'Record the approved contractual export deadline before ending this subscription.',
            );
          const row = (
            await tx.query(
              sub
                ? 'UPDATE subscriptions SET plan_id=$2,status=$3,current_period_end=$4,grace_ends_at=$5,limit_overrides=$6,billing_ref=$7,export_until=$8 WHERE id=$1 RETURNING *'
                : 'INSERT INTO subscriptions(school_id,plan_id,status,current_period_end,grace_ends_at,limit_overrides,billing_ref,export_until) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
              [
                sub?.id || school.id,
                plan.id,
                b.status,
                b.current_period_end,
                b.grace_ends_at === undefined ? (sub?.grace_ends_at ?? null) : b.grace_ends_at,
                b.limit_overrides === undefined
                  ? (sub?.limit_overrides ?? null)
                  : JSON.stringify(b.limit_overrides),
                b.billing_ref === undefined ? (sub?.billing_ref ?? null) : b.billing_ref,
                exportUntil,
              ],
            )
          ).rows[0];
          await tx.query(
            'INSERT INTO subscription_events(school_id,subscription_id,previous_status,new_status,reason,actor_id) VALUES($1,$2,$3,$4,$5,$6)',
            [id, row.id, sub?.status ?? null, b.status, b.reason, a.id],
          );
          await tx.query(
            "INSERT INTO audit_logs(school_id,actor_type,actor_id,action,entity_type,entity_id,after) VALUES($1,'USER',$2,'subscription.manual_change','subscriptions',$3,$4)",
            [
              id,
              a.id,
              row.id,
              { reason: b.reason, billing_ref: row.billing_ref, billing_mode: 'MANUAL' },
            ],
          );
          return row;
        }),
      );
    }),
  );
  r.get(
    '/devices',
    asyncRoute(async (req, res) =>
      res.json(
        await platformTx(platform, res.locals.actor.id, (tx) =>
          paged(
            tx,
            'SELECT d.id,d.school_id,d.device_code,d.name,d.status,d.firmware_version,d.last_seen_at,d.pending_event_count,d.reader_status,d.rtc_status,s.name AS school_name FROM devices d JOIN schools s ON s.id=d.school_id ORDER BY d.created_at DESC,d.id',
            [],
            req.query,
          ),
        ),
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
        await tx.query("SELECT set_config('app.change_reason',$1,true)", [b.reason]);
        const d = (await tx.query('SELECT * FROM devices WHERE id=$1 FOR UPDATE', [id])).rows[0];
        if (!d) throw notFound();
        if (d.status === 'REVOKED')
          throw new ApiError(
            409,
            'DEVICE_REVOKED',
            'A revoked reader cannot receive a new credential.',
          );
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
    asyncRoute(async (req, res) =>
      res.json(
        await platformTx(platform, res.locals.actor.id, (tx) =>
          paged(
            tx,
            'SELECT g.*,s.name AS school_label FROM support_access_grants g JOIN schools s ON s.id=g.school_id ORDER BY g.created_at DESC,g.id',
            [],
            req.query,
          ),
        ),
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
    '/support-grants/:id/academic-intelligence',
    asyncRoute(async (req, res) => {
      const actor = res.locals.actor;
      const grantId = uuid.parse(req.params.id);
      const filters = academicFilters.omit({ student_id: true }).parse(req.query);
      const grant = await platformTx(
        platform,
        actor.id,
        async (tx) =>
          (
            await tx.query<{ school_id: string }>(
              `SELECT school_id FROM support_access_grants WHERE id=$1 AND staff_user_id=$2
           AND approved_by IS NOT NULL AND starts_at<=now() AND expires_at>now()
           AND revoked_at IS NULL AND scope ? 'marks'`,
              [grantId, actor.id],
            )
          ).rows[0],
      );
      if (!grant) throw notFound();
      const school = grant.school_id;
      const result = await transaction(
        api,
        { schoolId: school, userId: actor.id, actorType: 'SUPPORT' },
        async (tx) => {
          const live = await tx.query(
            `SELECT id FROM support_access_grants WHERE school_id=$1 AND id=$2 AND staff_user_id=$3
           AND approved_by IS NOT NULL AND starts_at<=now() AND expires_at>now()
           AND revoked_at IS NULL AND scope ? 'marks' FOR SHARE`,
            [school, grantId, actor.id],
          );
          if (!live.rowCount) throw notFound();
          const data = await cohortData(tx, school, filters);
          await tx.query(
            `INSERT INTO audit_logs(school_id,actor_type,actor_id,support_grant_id,action,entity_type,entity_id)
           VALUES($1,'SUPPORT',$2,$3,'support.read','academic_analytics',$1)`,
            [school, actor.id, grantId],
          );
          return { ...data, standings: [] };
        },
      );
      res.setHeader('Cache-Control', 'private, no-store');
      res.json(result);
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
      const result = await transaction(
        api,
        { schoolId: grant.school_id, userId: a.id, actorType: 'SUPPORT' },
        async (tx) => {
          // Lock and revalidate inside the data transaction. Concurrent revocation
          // takes effect before any subsequent read; audit and data commit together.
          const live = (
            await tx.query(
              'SELECT scope FROM support_access_grants WHERE school_id=$1 AND id=$2 AND staff_user_id=$3 AND approved_by IS NOT NULL AND starts_at<=now() AND expires_at>now() AND revoked_at IS NULL FOR SHARE',
              [grant.school_id, id, a.id],
            )
          ).rows[0];
          if (!live?.scope.includes(feature)) throw notFound();
          const page = await paged(
            tx,
            `SELECT * FROM ${table} WHERE school_id=$1 ORDER BY created_at DESC,id`,
            [grant.school_id],
            req.query,
          );
          for (const record of page.data)
            await tx.query(
              "INSERT INTO audit_logs(school_id,actor_type,actor_id,support_grant_id,action,entity_type,entity_id) VALUES($1,'SUPPORT',$2,$3,'support.read',$4,$5)",
              [grant.school_id, a.id, id, table, record.id],
            );
          return page;
        },
      );
      res.json({
        ...result,
        grant: {
          id,
          ticket_ref: grant.ticket_ref,
          expires_at: grant.expires_at,
          scope: grant.scope,
        },
      });
    }),
  );
  return r;
}
export function supportApprovalRouter(pool: pg.Pool) {
  const r = Router();
  r.use(permission('users.manage'));
  r.get(
    '/',
    asyncRoute(async (req, res) => {
      const a = res.locals.actor;
      res.json(
        await transaction(
          pool,
          a.context,
          (tx) =>
            paged(
              tx,
              'SELECT id,reason,ticket_ref,scope,starts_at,expires_at,approved_by,revoked_at FROM support_access_grants WHERE school_id=$1 ORDER BY created_at DESC,id',
              [a.context.schoolId],
              req.query,
            ),
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
