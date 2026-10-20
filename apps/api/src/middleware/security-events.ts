import type { ErrorRequestHandler, RequestHandler } from 'express';
import type pg from 'pg';
import { createHmac } from 'node:crypto';
import { transaction, platformTx } from '../lib/db.js';
import { asyncRoute, ApiError } from '../lib/errors.js';

export function sharedRateLimit(
  pool: pg.Pool,
  key: string,
  limit: number,
  scope: (req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1]) => string,
): RequestHandler {
  return asyncRoute(async (req, res, next) => {
    const bucket = createHmac('sha256', key).update(scope(req, res)).digest('hex');
    const retry = Number(
      (await pool.query('SELECT app.take_http_token($1,$2,60) AS retry', [bucket, limit])).rows[0]
        .retry,
    );
    if (retry) {
      res.setHeader('Retry-After', String(retry));
      throw new ApiError(429, 'RATE_LIMITED', 'Please wait before trying again.');
    }
    next();
  });
}

export function auditDenied(api: pg.Pool, platform: pg.Pool): ErrorRequestHandler {
  return (error, req, res, next) => {
    const actor = res.locals.actor;
    if (!actor || ![403, 404].includes(error.status)) return next(error);
    const record = async (tx: import('../lib/db.js').Tx) => {
      await tx.query(
        "INSERT INTO audit_logs(school_id,actor_type,actor_id,action,entity_type,after,request_id) VALUES($1,'USER',$2,'access.denied','authorization',$3,$4)",
        [
          actor.active?.school_id || null,
          actor.id,
          { code: error.code, method: req.method, path: req.path.slice(0, 180) },
          res.locals.requestId,
        ],
      );
    };
    const work = actor.active
      ? transaction(api, actor.context, record)
      : actor.platform_role === 'SUPER_ADMIN'
        ? platformTx(platform, actor.id, record)
        : Promise.resolve();
    work
      .catch(() =>
        req.log.error(
          { code: 'DENIED_ACCESS_AUDIT_FAILED', request_id: res.locals.requestId },
          'Security event could not be recorded',
        ),
      )
      .finally(() => next(error));
  };
}
