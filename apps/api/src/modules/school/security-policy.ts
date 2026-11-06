import { Router } from 'express';
import type pg from 'pg';
import {
  pageSchema,
  securityPolicyDefaults,
  securityPolicySchema,
  type SchoolSecurityPolicy,
} from '@vidyalayaa/contracts';
import { transaction, audit, type Tx } from '../../lib/db.js';
import { asyncRoute, ApiError } from '../../lib/errors.js';
import { permission, schoolRoles, type Actor } from '../../middleware/auth.js';

type StoredPolicy = Partial<SchoolSecurityPolicy> & { idle_timeout_changed_at?: string };
function policyView(raw: StoredPolicy | null): SchoolSecurityPolicy {
  const { idle_timeout_changed_at: _idle, ...stored } = raw || {};
  return {
    ...securityPolicyDefaults,
    version: 0,
    approved_at: null,
    approved_by: null,
    approved_by_name: null,
    ...stored,
    mfa_finance_staff: stored.mfa_finance_staff ?? stored.require_privileged_mfa ?? false,
  };
}

async function recoveryReady(tx: Tx) {
  return (await tx.query('SELECT app.school_mfa_recovery_ready() AS ready')).rows[0].ready === true;
}

export function securityPolicyRouter(
  pool: pg.Pool,
  requireWrite: (tx: Tx, actor: Actor) => Promise<void>,
) {
  const router = Router();
  router.use(schoolRoles('school_admin'), permission('school.manage'));
  router.get(
    '/',
    asyncRoute(async (_req, res) => {
      const { context } = res.locals.actor;
      res.json(
        await transaction(
          pool,
          context,
          async (tx) => {
            const row = (
              await tx.query<{ policy: StoredPolicy | null; approver: string | null }>(
                `SELECT s.settings->'security' AS policy,u.full_name AS approver FROM schools s
         LEFT JOIN users u ON u.id::text=s.settings->'security'->>'approved_by'
         WHERE s.id=$1`,
                [context.schoolId],
              )
            ).rows[0];
            return {
              ...policyView(row.policy),
              approved_by_name: row.approver ?? row.policy?.approved_by_name ?? null,
              recovery_ready: await recoveryReady(tx),
            };
          },
          true,
        ),
      );
    }),
  );
  router.put(
    '/',
    asyncRoute(async (req, res) => {
      const a = res.locals.actor;
      const { expected_version, confirm_enforcement, ...input } = securityPolicySchema.parse(
        req.body,
      );
      const updated = await transaction(pool, a.context, async (tx) => {
        await requireWrite(tx, a);
        const school = a.context.schoolId;
        const raw = (
          await tx.query<{ policy: StoredPolicy | null }>(
            "SELECT settings->'security' AS policy FROM schools WHERE id=$1 FOR UPDATE",
            [school],
          )
        ).rows[0].policy;
        const current = policyView(raw);
        if (!current.approved_by_name && current.approved_by) {
          current.approved_by_name =
            (await tx.query('SELECT full_name FROM users WHERE id=$1', [current.approved_by]))
              .rows[0]?.full_name ?? null;
        }
        if ((expected_version ?? 0) !== current.version)
          throw new ApiError(
            409,
            'POLICY_VERSION_CHANGED',
            'Reload the latest policy before saving.',
          );

        const next = { ...current, ...input };
        // Preserve the pre-upgrade finance behavior for legacy clients and untouched policies.
        next.mfa_finance_staff =
          input.mfa_finance_staff ?? raw?.mfa_finance_staff ?? next.require_privileged_mfa;
        const mfaIncreased =
          (!current.require_privileged_mfa && next.require_privileged_mfa) ||
          (!current.mfa_teachers && next.mfa_teachers) ||
          (!current.mfa_finance_staff && next.mfa_finance_staff) ||
          (!current.step_up_sensitive && next.step_up_sensitive);
        if (mfaIncreased && !a.recentVerification)
          throw new ApiError(
            403,
            a.hasVerifiedFactor ? 'MFA_STEP_UP_REQUIRED' : 'MFA_ENROLLMENT_REQUIRED',
            'Verify an authenticator code before increasing MFA enforcement.',
          );
        const restrictionsIncreased =
          mfaIncreased ||
          (current.student_login_enabled && !next.student_login_enabled) ||
          (current.parent_login_enabled && !next.parent_login_enabled) ||
          (next.idle_timeout_minutes !== null &&
            (current.idle_timeout_minutes === null ||
              next.idle_timeout_minutes < current.idle_timeout_minutes));
        if (restrictionsIncreased && !confirm_enforcement)
          throw new ApiError(
            422,
            'POLICY_CONFIRMATION_REQUIRED',
            'Confirm how this change will affect active users.',
          );
        if (mfaIncreased && (!(await recoveryReady(tx)) || !next.approval_details))
          throw new ApiError(
            409,
            'MFA_RECOVERY_REQUIRED',
            'A second active School Admin must sign in with verified MFA within seven days. Record the recovery steps in the approval details.',
          );

        const timestamp = new Date().toISOString();
        const saved = {
          ...next,
          version: current.version + 1,
          approved_at: timestamp,
          approved_by: a.id,
          approved_by_name: a.full_name,
        };
        const stored = {
          ...saved,
          idle_timeout_changed_at:
            current.idle_timeout_minutes !== next.idle_timeout_minutes
              ? timestamp
              : raw?.idle_timeout_changed_at,
        };
        // Keep an immutable copy of the original policy when the first version is written.
        if (!current.version)
          await tx.query(
            'INSERT INTO app.school_security_policy_versions(school_id,version,policy) VALUES($1,0,$2)',
            [school, current],
          );
        await tx.query(
          "UPDATE schools SET settings=jsonb_set(settings,'{security}',$2,true) WHERE id=$1",
          [school, stored],
        );
        await tx.query(
          'INSERT INTO app.school_security_policy_versions(school_id,version,policy) VALUES($1,$2,$3)',
          [school, saved.version, saved],
        );
        await audit(tx, school, a.id, 'security.policy.updated', 'schools', school);
        return { ...saved, recovery_ready: await recoveryReady(tx) };
      });
      res.json(updated);
    }),
  );
  router.get(
    '/history',
    asyncRoute(async (req, res) => {
      const { context } = res.locals.actor;
      const { page, page_size } = pageSchema.parse(req.query);
      res.json(
        await transaction(
          pool,
          context,
          async (tx) => ({
            data: (
              await tx.query(
                'SELECT policy FROM app.school_security_policy_versions WHERE school_id=$1 ORDER BY version DESC LIMIT $2 OFFSET $3',
                [context.schoolId, page_size + 1, (page - 1) * page_size],
              )
            ).rows.map((row) => row.policy),
          }),
          true,
        ).then(({ data }) => ({ data: data.slice(0, page_size), more: data.length > page_size })),
      );
    }),
  );
  router.get(
    '/audit',
    asyncRoute(async (req, res) => {
      const { context } = res.locals.actor;
      const { page, page_size } = pageSchema.parse(req.query);
      res.json(
        await transaction(
          pool,
          context,
          async (tx) => {
            const rows = (
              await tx.query('SELECT * FROM app.school_security_events($1,$2)', [
                page_size + 1,
                (page - 1) * page_size,
              ])
            ).rows;
            return { data: rows.slice(0, page_size), more: rows.length > page_size };
          },
          true,
        ),
      );
    }),
  );
  return router;
}
