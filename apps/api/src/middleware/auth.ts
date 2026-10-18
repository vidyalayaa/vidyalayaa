import type { RequestHandler } from 'express';
import type pg from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Me, Membership } from '@vidyalayaa/contracts';
import { ApiError, asyncRoute, notFound } from '../lib/errors.js';
import { transaction, type TenantContext } from '../lib/db.js';
import { equalHash } from '../lib/crypto.js';
export interface Actor extends Me {
  context: TenantContext;
  active?: Membership;
  aal2: boolean;
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
    try {
      aal2 = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).aal === 'aal2';
    } catch {
      /* no step-up */
    }
    const selected = req.header('X-School-Id');
    const active = selected
      ? me.memberships.find((x) => x.school_id === selected)
      : me.memberships.length === 1
        ? me.memberships[0]
        : undefined;
    if (selected && !active) throw notFound();
    res.locals.actor = {
      ...me,
      features: {},
      limits: {},
      subscription_status: null,
      aal2,
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
export const requireSchool: RequestHandler = (_req, res, next) => {
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
        'SELECT s.status,s.current_period_end,s.grace_ends_at,p.features,p.limits,s.limit_overrides FROM subscriptions s JOIN subscription_plans p ON p.id=s.plan_id WHERE school_id=$1 ORDER BY s.created_at DESC LIMIT 1',
        [a.context.schoolId],
      );
      const s = rows[0];
      return {
        features: s?.features || {},
        limits: { ...s?.limits, ...s?.limit_overrides },
        subscription_status: s?.status || 'UNCONFIGURED',
      };
    },
    true,
  );
}
