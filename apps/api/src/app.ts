import { firmwareRouter } from './modules/devices/ota.js';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { pinoHttp } from 'pino-http';
import pino from 'pino';
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type pg from 'pg';
import type { Config } from './lib/config.js';
import { asyncRoute, errorHandler, ApiError } from './lib/errors.js';
import { makePool } from './lib/db.js';
import { userAuth, requireSchool, loadEntitlements } from './middleware/auth.js';
import { exportsRouter } from './modules/school/exports.js';
import { supportRouter } from './modules/school/support.js';
import { workflowsRouter } from './modules/school/workflows.js';
import { bulkRouter } from './modules/school/bulk.js';
import { schoolRouter, schoolAccess, requireWrite } from './modules/school/router.js';
import { securityPolicyRouter } from './modules/school/security-policy.js';
import { deviceRouter, managementRouter } from './modules/devices/router.js';
import { billingRouter } from './modules/platform/billing.js';
import { platformRouter, supportApprovalRouter } from './modules/platform/router.js';
import { schoolDeletionApprovalRouter } from './modules/platform/school-deletion.js';
import { sharedRateLimit, auditDenied } from './middleware/security-events.js';
import { recipientInvitationRouter } from './modules/identity/invitations.js';
import { sessionsRouter } from './modules/identity/sessions.js';
import { accountRouter } from './modules/identity/account.js';
export interface Dependencies {
  api: pg.Pool;
  device: pg.Pool;
  platform: pg.Pool;
  supabase: SupabaseClient;
}
export function createDependencies(config: Config): Dependencies {
  return {
    api: makePool(config.DATABASE_URL, config),
    device: makePool(config.DEVICE_DATABASE_URL, config),
    platform: makePool(config.PLATFORM_DATABASE_URL, config),
    supabase: createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    }),
  };
}
export function createApp(config: Config, deps: Dependencies) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY_HOPS);
  app.use((_req, res, next) => {
    res.locals.requestId = randomUUID();
    res.setHeader('X-Request-Id', res.locals.requestId);
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(
    pinoHttp({
      genReqId: (_req, res) => String(res.getHeader('X-Request-Id')),
      logger: pino({
        level: config.NODE_ENV === 'test' ? 'silent' : 'info',
        redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie'],
      }),
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, path: String(req.url).split('?')[0] }),
      },
    }),
  );
  app.use(helmet());
  const origins = config.WEB_ORIGINS.split(',').map((x) => x.trim());
  const isDevOrigin = (origin?: string) => {
    if (!origin || config.NODE_ENV !== 'development') return false;
    return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  };
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || origins.includes(origin) || isDevOrigin(origin)),
      allowedHeaders: [
        'Authorization',
        'Content-Type',
        'X-School-Id',
        'Idempotency-Key',
        'X-Device-Id',
        'If-None-Match',
      ],
      exposedHeaders: ['X-Request-Id', 'ETag', 'X-Server-Time', 'Retry-After'],
      maxAge: 600,
    }),
  );
  app.get(
    '/health/worker',
    asyncRoute(async (_req, res) => {
      const release = process.env.RENDER_GIT_COMMIT || 'development';
      try {
        const ready =
          (await deps.api.query('SELECT app.worker_release_ready($1) AS ready', [release])).rows[0]
            ?.ready === true;
        res.status(ready ? 200 : 503).json({ status: ready ? 'ok' : 'degraded', release });
      } catch {
        res.status(503).json({ status: 'degraded', release });
      }
    }),
  );
  app.get('/health/live', (_req, res) => res.json({ status: 'ok' }));
  app.get(
    '/health/ready',
    asyncRoute(async (_req, res) => {
      try {
        await deps.api.query('SELECT 1');
        res.json({ status: 'ok', release: process.env.RENDER_GIT_COMMIT || 'development' });
      } catch {
        res.status(503).json({ status: 'degraded' });
      }
    }),
  );
  app.use(
    rateLimit({
      windowMs: 60000,
      limit: 600,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: (_req, res) =>
        res.status(429).json({
          error: { code: 'RATE_LIMITED', message: 'Too many requests.' },
          server_time: new Date().toISOString(),
        }),
    }),
  );
  app.use(
    '/api/v1/device',
    deviceRouter(deps.device, deps.supabase, config.FIRMWARE_RELEASE_PUBLIC_KEY),
  );
  app.use('/api/v1/billing/webhook', billingRouter(deps.platform));
  app.use(express.json({ limit: '1mb' }));
  if (config.NODE_ENV !== 'test')
    app.use(
      '/api/v1',
      sharedRateLimit(deps.api, config.TOKEN_ENCRYPTION_KEY, 600, (req) => 'ip:' + req.ip),
    );
  app.use('/api/v1', userAuth(deps.api, deps.supabase));
  if (config.NODE_ENV !== 'test') {
    app.use(
      '/api/v1',
      sharedRateLimit(
        deps.api,
        config.TOKEN_ENCRYPTION_KEY,
        120,
        (_req, res) => 'user:' + res.locals.actor.id,
      ),
    );
    app.use(
      ['/api/v1/reports', '/api/v1/marks/bulk', '/api/v1/imports'],
      sharedRateLimit(
        deps.api,
        config.TOKEN_ENCRYPTION_KEY,
        5,
        (_req, res) => 'bulk:' + res.locals.actor.id,
      ),
    );
  }
  app.get(
    '/api/v1/me',
    asyncRoute(async (_req, res) => {
      const a = res.locals.actor;
      const e = a.active
        ? await loadEntitlements(deps.api, a)
        : { features: {}, limits: {}, subscription_status: null };
      const {
        context: _context,
        aal2: _aal,
        securityPolicy: _policy,
        recentVerification: _recent,
        active,
        sessionId: _sessionId,
        ...me
      } = a;
      res.json({ ...me, ...e, school: active });
    }),
  );
  app.use('/api/v1/invitations', recipientInvitationRouter(deps.api));
  app.use('/api/v1/account/sessions', sessionsRouter(deps.api));
  app.use('/api/v1/account', accountRouter(deps.api));
  app.use(
    '/api/v1/platform',
    firmwareRouter(deps.platform, deps.supabase, config.FIRMWARE_RELEASE_PUBLIC_KEY),
  );
  app.use('/api/v1/platform', platformRouter(deps.platform, deps.api, deps.supabase, config));
  app.use('/api/v1', requireSchool, schoolAccess(deps.api));
  app.use('/api/v1', schoolDeletionApprovalRouter(deps.api, config.TOKEN_ENCRYPTION_KEY));
  app.use('/api/v1/school/security', securityPolicyRouter(deps.api, requireWrite));
  app.use('/api/v1', exportsRouter(deps.api, deps.supabase, config.TOKEN_ENCRYPTION_KEY));
  app.use('/api/v1', workflowsRouter(deps.api));
  app.use('/api/v1', supportRouter(deps.api));
  app.use('/api/v1', bulkRouter(deps.api));
  app.use('/api/v1/devices', managementRouter(deps.api));
  app.use('/api/v1/support-grants', supportApprovalRouter(deps.api));
  app.use('/api/v1', schoolRouter(deps.api, deps.supabase, config));
  app.use((_req, _res, next) =>
    next(new ApiError(404, 'NOT_FOUND', 'The requested endpoint was not found.')),
  );
  app.use(auditDenied(deps.api, deps.platform));
  app.use(errorHandler);
  return app;
}
