import { createHmac, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { uuid } from '@vidyalayaa/contracts';
import { platformTx, transaction, type Tx } from '../../lib/db.js';
import { ApiError, asyncRoute, notFound } from '../../lib/errors.js';
import type { Actor } from '../../middleware/auth.js';

const confirmation = z.object({
  confirm: z.literal('DELETE'),
  school_name: z.string().min(1).max(200),
});
const initiation = confirmation
  .extend({
    approver_id: uuid,
    policy_ref: z.string().trim().min(5).max(200),
    reason: z.string().trim().min(10).max(2000),
    export_until: z.string().datetime(),
    delete_after: z.string().datetime(),
  })
  .strict();
const approval = z
  .object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), approve: z.boolean() })
  .strict();

export function requireDeletionVerification(actor: Actor) {
  if (!actor.aal2 || !actor.hasVerifiedFactor || !actor.recentVerification)
    throw new ApiError(
      403,
      'MFA_STEP_UP_REQUIRED',
      'Verify your own authenticator before continuing.',
    );
}

function approvalToken(key: string, job: string, school: string, recipient: string) {
  return createHmac('sha256', Buffer.from(key, 'hex'))
    .update(JSON.stringify(['school-deletion-approval', job, school, recipient]))
    .digest('base64url');
}

async function validateSchoolName(tx: Tx, schoolId: string, typed: string) {
  const school = (
    await tx.query('SELECT name,status FROM schools WHERE id=$1 FOR SHARE', [schoolId])
  ).rows[0];
  if (!school || school.status === 'TERMINATED') throw notFound();
  if (typed !== school.name)
    throw new ApiError(400, 'SCHOOL_NAME_MISMATCH', 'Enter the exact name of the selected school.');
}

export function platformSchoolDeletionRouter(pool: pg.Pool) {
  const r = Router();
  r.get(
    '/schools/:id/deletion-approvers',
    asyncRoute(async (req, res) => {
      const id = uuid.parse(req.params.id);
      res.json(
        await platformTx(pool, res.locals.actor.id, async (tx) => ({
          data: (await tx.query('SELECT * FROM app.school_deletion_approvers($1)', [id])).rows,
        })),
      );
    }),
  );

  r.post(
    '/schools/:id/permanent-deletion',
    asyncRoute(async (req, res) => {
      const actor = res.locals.actor;
      requireDeletionVerification(actor);
      const id = uuid.parse(req.params.id),
        body = initiation.parse(req.body);
      if (
        Date.parse(body.export_until) <= Date.now() + 86400000 ||
        Date.parse(body.delete_after) < Date.parse(body.export_until)
      )
        throw new ApiError(
          400,
          'INVALID_DELETION_WINDOW',
          'Allow at least 24 hours for export and honor the approved retention deadline.',
        );
      const job = await platformTx(pool, actor.id, async (tx) => {
        await validateSchoolName(tx, id, body.school_name);
        if (
          !(
            await tx.query('SELECT id FROM app.school_deletion_approvers($1) WHERE id=$2', [
              id,
              body.approver_id,
            ])
          ).rowCount
        )
          throw new ApiError(
            409,
            'APPROVER_UNAVAILABLE',
            'Choose an active School Admin with a verified email and authenticator.',
          );
        await tx.query(
          "UPDATE school_offboarding SET status='CANCELLED' WHERE school_id=$1 AND permanent AND status='REQUESTED' AND approval_expires_at<=now()",
          [id],
        );
        const { rows } = await tx.query(
          `INSERT INTO school_offboarding(school_id,requested_by,policy_ref,reason,export_until,delete_after,
           permanent,approval_recipient,approval_expires_at)
         VALUES($1,$2,$3,$4,$5,$6,true,$7,clock_timestamp()+interval '24 hours')
         ON CONFLICT(school_id) WHERE status NOT IN ('CANCELLED','PURGED') DO NOTHING
         RETURNING id,status,approval_expires_at`,
          [
            id,
            actor.id,
            body.policy_ref,
            body.reason,
            body.export_until,
            body.delete_after,
            body.approver_id,
          ],
        );
        if (!rows.length)
          throw new ApiError(
            409,
            'DELETION_ALREADY_REQUESTED',
            'This school already has an active closure or deletion request.',
          );
        return rows[0];
      });
      res.status(201).json(job);
    }),
  );

  r.post(
    '/schools/:id/permanent-deletion/:job/execute',
    asyncRoute(async (req, res) => {
      const actor = res.locals.actor;
      requireDeletionVerification(actor);
      const id = uuid.parse(req.params.id),
        job = uuid.parse(req.params.job);
      const body = confirmation.strict().parse(req.body);
      await platformTx(pool, actor.id, async (tx) => {
        // Lock the request before the school, as the closure and worker do.
        const current = (
          await tx.query(
            'SELECT status,approval_recipient FROM school_offboarding WHERE id=$1 AND school_id=$2 AND permanent FOR UPDATE',
            [job, id],
          )
        ).rows[0];
        if (!current) throw notFound();
        await validateSchoolName(tx, id, body.school_name);
        if (['PURGE_REQUESTED', 'PURGING'].includes(current.status)) return;
        const approved = (
          await tx.query('SELECT id FROM app.school_deletion_approvers($1) WHERE id=$2', [
            id,
            current.approval_recipient,
          ])
        ).rowCount;
        if (!approved)
          throw new ApiError(
            409,
            'APPROVER_UNAVAILABLE',
            'The approving School Admin must still be active and verified for this school.',
          );
        const result = await tx.query(
          `UPDATE school_offboarding o SET status='PURGE_REQUESTED',purge_requested_by=$3,purge_requested_at=clock_timestamp()
         WHERE o.id=$1 AND o.school_id=$2 AND o.permanent AND o.status='CLOSED'
           AND o.approved_at IS NOT NULL AND o.school_approved_by=o.approval_recipient AND o.school_approved_by<>$3
           AND NOT o.legal_hold AND o.delete_after<=now() AND o.export_until<=now()
           AND EXISTS(SELECT FROM school_exports e WHERE e.school_id=o.school_id AND e.status='COMPLETED'
                      AND e.snapshot_at>=o.closed_at)
         RETURNING o.id`,
          [job, id, actor.id],
        );
        if (!result.rowCount)
          throw new ApiError(
            409,
            'PURGE_NOT_APPROVED',
            'School Admin approval, closure, a completed final export, elapsed retention and export deadlines, and a cleared legal hold are required.',
          );
      });
      res.status(202).json({ status: 'PURGE_REQUESTED' });
    }),
  );
  return r;
}

export function schoolDeletionApprovalRouter(pool: pg.Pool, key: string) {
  const r = Router();
  r.get(
    '/offboarding/deletion-approval',
    asyncRoute(async (_req, res) => {
      const actor = res.locals.actor;
      if (actor.active?.role !== 'school_admin') throw notFound();
      const school = actor.context.schoolId;
      const row = await transaction(
        pool,
        actor.context,
        async (tx) =>
          (
            await tx.query(
              `SELECT id,reason,policy_ref,approval_expires_at,export_until,delete_after FROM school_offboarding
       WHERE school_id=$1 AND approval_recipient=$2 AND permanent AND status='REQUESTED'
       AND approval_expires_at>clock_timestamp()`,
              [school, actor.id],
            )
          ).rows[0],
        true,
      );
      res.set('Cache-Control', 'no-store').json({
        request: row ? { ...row, token: approvalToken(key, row.id, school, actor.id) } : null,
      });
    }),
  );
  r.post(
    '/offboarding/deletion-approval/:job',
    asyncRoute(async (req, res) => {
      const actor = res.locals.actor;
      if (actor.active?.role !== 'school_admin') throw notFound();
      requireDeletionVerification(actor);
      const school = actor.context.schoolId,
        job = uuid.parse(req.params.job);
      const { token, approve } = approval.parse(req.body);
      if (
        !timingSafeEqual(Buffer.from(token), Buffer.from(approvalToken(key, job, school, actor.id)))
      )
        throw notFound();
      await transaction(pool, actor.context, async (tx) => {
        if (
          !(await tx.query("SELECT app.school_role($1)='school_admin' AS allowed", [school]))
            .rows[0]?.allowed
        )
          throw notFound();
        const result = await tx.query(
          `UPDATE school_offboarding SET status=CASE WHEN $4 THEN 'APPROVED' ELSE 'CANCELLED' END,
         school_approved_by=CASE WHEN $4 THEN $3::uuid ELSE NULL END,
         approved_at=CASE WHEN $4 THEN now() ELSE NULL END
         WHERE school_id=$1 AND id=$2 AND approval_recipient=$3 AND permanent AND status='REQUESTED'
         AND approval_expires_at>clock_timestamp() RETURNING id`,
          [school, job, actor.id, approve],
        );
        if (!result.rowCount)
          throw new ApiError(
            409,
            'APPROVAL_UNAVAILABLE',
            'This approval request expired or has already been used.',
          );
      });
      res.status(204).end();
    }),
  );
  return r;
}
