import type { RequestHandler } from 'express';
import type pg from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Me, Membership, Role, SchoolSecurityPolicy } from '@vidyalayaa/contracts';
import { ApiError, asyncRoute } from '../lib/errors.js';
import { transaction, type TenantContext } from '../lib/db.js';
import { equalHash } from '../lib/crypto.js';
export interface Actor extends Me {
  sessionId: string;
  context: TenantContext;
  active?: Membership;
  aal2: boolean;
  securityPolicy?: Partial<SchoolSecurityPolicy>;
  security_mfa_required?: boolean;
  recentVerification?: boolean;
  hasVerifiedFactor?: boolean;
}
declare global {
  namespace Express {
    interface Locals {
      actor: Actor;
      device: { id: string; schoolId: string; code: string; status: string };
      requestId: string;
    }
  }
}
export function userAuth(pool: pg.Pool, auth: SupabaseClient): RequestHandler {
  return asyncRoute(async (req, res, next) => {
    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!token) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
    const { data, error } = await auth.auth.getUser(token);
    if (error && (error.name === 'AuthRetryableFetchError' || (error.status || 0) >= 500))
      throw new ApiError(
        503,
        'DEPENDENCY_UNAVAILABLE',
        'Authentication is temporarily unavailable.',
      );
    if (error || !data.user)
      throw new ApiError(401, 'UNAUTHENTICATED', 'Your session has expired.');
    const { rows } = await pool.query('SELECT app.auth_context($1) AS context', [data.user.id]);
    const me = rows[0]?.context as Me | undefined;
    if (!me) throw new ApiError(403, 'ACCOUNT_UNAVAILABLE', 'Your account is not active.');
    // getUser verified the signature and current identity; read aal only from that verified token.
    let aal2 = false;
    let sessionId: string | undefined;
    let expired = false;
    let totpVerifiedAt: number | undefined;
    try {
      const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
      expired = typeof claims.exp === 'number' && claims.exp <= Date.now() / 1000;
      aal2 = claims.aal === 'aal2';
      if (aal2 && Array.isArray(claims.amr)) {
        const now = Date.now() / 1000;
        for (const event of claims.amr) {
          if (
            ['totp', 'mfa/totp'].includes(event?.method) &&
            typeof event.timestamp === 'number' &&
            event.timestamp <= now &&
            event.timestamp > now - 900
          )
            totpVerifiedAt = Math.max(totpVerifiedAt ?? 0, event.timestamp);
        }
      }
      if (
        typeof claims.session_id === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(claims.session_id)
      )
        sessionId = claims.session_id;
    } catch {
      /* no step-up */
    }
    if (expired)
      throw new ApiError(
        401,
        'UNAUTHENTICATED',
        'Your access token has expired. Refresh your session.',
      );
    if (!sessionId)
      throw new ApiError(401, 'SESSION_ENDED', 'This login session has ended. Sign in again.');
    const hasVerifiedFactor = !!data.user.factors?.some((factor) => factor.status === 'verified');
    if (!aal2 && hasVerifiedFactor)
      throw new ApiError(403, 'MFA_REQUIRED', 'Complete multi-factor authentication to continue.');
    const policies = new Map<string, Partial<SchoolSecurityPolicy>>();
    for (const member of me.memberships) {
      const policy =
        (await pool.query('SELECT app.school_security_policy($1) AS policy', [member.school_id]))
          .rows[0]?.policy || {};
      policies.set(member.school_id, policy);
    }
    const selected = req.header('X-School-Id');
    const deniedSchools = new Set(
      me.memberships
        .filter((member) => {
          const policy = policies.get(member.school_id);
          return (
            (member.role === 'student' && policy?.student_login_enabled === false) ||
            (member.role === 'parent' && policy?.parent_login_enabled === false)
          );
        })
        .map((member) => member.school_id),
    );
    me.memberships = me.memberships.filter((member) => !deniedSchools.has(member.school_id));
    const schoolLoginDenied = selected
      ? deniedSchools.has(selected)
      : !me.memberships.length && deniedSchools.size > 0 && !me.platform_role;
    const active = selected
      ? me.memberships.find((x) => x.school_id === selected)
      : me.memberships.length === 1
        ? me.memberships[0]
        : undefined;
    const policy = active && policies.get(active.school_id);
    const schoolMfa =
      active &&
      ((['school_admin', 'principal'].includes(active.role) && policy?.require_privileged_mfa) ||
        (active.role === 'teacher' && policy?.mfa_teachers) ||
        (active.role === 'finance_staff' &&
          (policy?.mfa_finance_staff ?? policy?.require_privileged_mfa)));
    const requiresMfa = !aal2 && (me.platform_role === 'SUPER_ADMIN' || !!schoolMfa);
    const workspaceAdmitted = !requiresMfa && !schoolLoginDenied && (!selected || !!active);
    const session = (
      await pool.query<{
        session: { live: boolean; inactive?: boolean; idle_expires_at?: string | null };
      }>('SELECT app.check_workspace_login_session($1,$2,$3,$4,to_timestamp($5)) AS session', [
        me.id,
        sessionId,
        workspaceAdmitted && req.method === 'POST' && req.path === '/account/sessions/activity',
        workspaceAdmitted,
        totpVerifiedAt ?? null,
      ])
    ).rows[0]?.session;
    if (!session?.live)
      throw new ApiError(
        401,
        'SESSION_ENDED',
        session?.inactive
          ? 'Your session ended after inactivity. Sign in again.'
          : 'This login session has ended. Sign in again.',
      );
    if (schoolLoginDenied && (selected || req.path === '/me'))
      throw new ApiError(
        403,
        'SCHOOL_LOGIN_DISABLED',
        'Your school has paused sign-in for this account role.',
      );
    if (selected && !active)
      throw new ApiError(
        404,
        'SCHOOL_CONTEXT_UNAVAILABLE',
        'This school is unavailable. Choose a school you still have access to.',
      );
    if (workspaceAdmitted)
      await pool.query('SELECT app.record_privileged_login($1,$2)', [me.id, sessionId]);
    res.locals.actor = {
      ...me,
      sessionId,
      features: {},
      limits: {},
      subscription_status: null,
      aal2,
      recentVerification: totpVerifiedAt !== undefined,
      hasVerifiedFactor,
      securityPolicy: policy,
      security_mfa_required: requiresMfa,
      idle_expires_at: session.idle_expires_at ?? null,
      active,
      context: {
        schoolId: active?.school_id || '',
        userId: me.id,
        actorType: 'USER',
        requestId: res.locals.requestId,
      },
    };
    next();
  });
}
export const requireSchool: RequestHandler = (req, res, next) => {
  const actor = res.locals.actor;
  if (actor.security_mfa_required)
    return next(
      new ApiError(
        403,
        'MFA_ENROLLMENT_REQUIRED',
        'Your school requires an authenticator. Set it up and verify a code to continue.',
      ),
    );
  if (
    actor.securityPolicy?.step_up_sensitive &&
    !actor.recentVerification &&
    !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
    /^\/(memberships|invitations|devices|support-grants|reports|exports|school\/(security|retention)|profiles\/staff\/from-membership)(\/|$)/.test(
      req.path,
    )
  )
    return next(
      new ApiError(
        403,
        actor.hasVerifiedFactor ? 'MFA_STEP_UP_REQUIRED' : 'MFA_ENROLLMENT_REQUIRED',
        actor.hasVerifiedFactor
          ? 'Verify your authenticator again before this sensitive change.'
          : 'Set up an authenticator before this sensitive change.',
      ),
    );
  if (!res.locals.actor.active) {
    next(new ApiError(400, 'SCHOOL_REQUIRED', 'Select a school to continue.'));
    return;
  }
  next();
};
export function permission(code: string): RequestHandler {
  return (_req, res, next) => {
    if (!res.locals.actor.active?.permissions.includes(code))
      next(new ApiError(403, 'FORBIDDEN', 'Your role does not allow this action.'));
    else next();
  };
}
export function schoolRoles(...roles: Role[]): RequestHandler {
  return (_req, res, next) => {
    const role = res.locals.actor.active?.role;
    if (!role || !roles.includes(role))
      return next(new ApiError(403, 'FORBIDDEN', 'Your role does not allow this action.'));
    next();
  };
}
export const platformOnly: RequestHandler = (_req, res, next) => {
  const a = res.locals.actor;
  if (a.platform_role !== 'SUPER_ADMIN')
    return next(new ApiError(403, 'FORBIDDEN', 'Platform administrator access required.'));
  if (!a.aal2)
    return next(
      new ApiError(403, 'MFA_REQUIRED', 'Complete multi-factor authentication to continue.'),
    );
  next();
};
export function deviceAuth(pool: pg.Pool): RequestHandler {
  return asyncRoute(async (req, res, next) => {
    const code = req.header('X-Device-Id'),
      token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!code || !token || code.length > 64 || token.length > 256)
      throw new ApiError(401, 'UNAUTHENTICATED', 'Invalid device credentials.');
    const { rows } = await pool.query('SELECT * FROM app.device_auth($1)', [code]);
    const match = rows.find((x) => equalHash(token, x.secret_hash));
    if (!match) throw new ApiError(401, 'UNAUTHENTICATED', 'Invalid device credentials.');
    if (match.status === 'REVOKED')
      throw new ApiError(401, 'DEVICE_REVOKED', 'The device credential has been revoked.');
    if (match.status === 'DISABLED')
      throw new ApiError(403, 'DEVICE_DISABLED', 'This device is disabled.');
    if (match.status !== 'ACTIVE' && !['/config', '/heartbeat'].includes(req.path))
      throw new ApiError(403, 'DEVICE_DISABLED', 'The device is not claimed.');
    res.locals.device = { id: match.id, schoolId: match.school_id, code, status: match.status };
    next();
  });
}
export async function loadEntitlements(pool: pg.Pool, a: Actor) {
  return transaction(
    pool,
    a.context,
    async (tx) => {
      const { rows } = await tx.query(
        "SELECT s.status,s.current_period_end,s.grace_ends_at,p.name as plan_name,p.features,p.limits,s.limit_overrides,sch.settings->>'locale' AS locale FROM subscriptions s JOIN subscription_plans p ON p.id=s.plan_id JOIN schools sch ON sch.id=s.school_id WHERE school_id=$1 ORDER BY s.created_at DESC LIMIT 1",
        [a.context.schoolId],
      );
      const s = rows[0];
      return {
        plan_name: s?.plan_name || 'Unconfigured',
        locale: s?.locale || 'en-IN',
        current_period_end: s?.current_period_end || null,
        grace_ends_at: s?.grace_ends_at || null,
        features: s?.features || {},
        limits: { ...s?.limits, ...s?.limit_overrides },
        subscription_status: s?.status || 'UNCONFIGURED',
      };
    },
    true,
  );
}
