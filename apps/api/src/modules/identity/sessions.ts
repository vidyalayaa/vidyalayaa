import { Router } from 'express';
import type pg from 'pg';
import { uuid, type LoginSessionsResponse } from '@vidyalayaa/contracts';
import { asyncRoute, notFound } from '../../lib/errors.js';
import { transaction } from '../../lib/db.js';

// Labels are deliberately coarse: user agent strings are untrusted hints, not identity.
export function describeDevice(agent: string | null) {
  const ua = (agent || '').slice(0, 512);
  const browser = /Edg(e|A|iOS)?\//i.test(ua)
    ? 'Microsoft Edge'
    : /OPR\//i.test(ua)
      ? 'Opera'
      : /Firefox\/|FxiOS\//i.test(ua)
        ? 'Firefox'
        : /Chrome\/|CriOS\//i.test(ua)
          ? 'Chrome'
          : /Safari\//i.test(ua)
            ? 'Safari'
            : 'Unknown browser';
  const device = /iPad/i.test(ua)
    ? 'iPad'
    : /iPhone/i.test(ua)
      ? 'iPhone'
      : /Android/i.test(ua)
        ? 'Android device'
        : /Windows/i.test(ua)
          ? 'Windows computer'
          : /Macintosh|Mac OS X/i.test(ua)
            ? 'Mac'
            : /Linux/i.test(ua)
              ? 'Linux computer'
              : 'Unknown device';
  return { browser, device };
}
export function sessionsRouter(pool: pg.Pool) {
  const router = Router();
  router.get(
    '/',
    asyncRoute(async (_req, res) => {
      const a = res.locals.actor;
      const result = await transaction(
        pool,
        a.context,
        async (tx) => {
          const sessions = (await tx.query('SELECT * FROM app.account_sessions($1)', [a.sessionId]))
            .rows;
          const events = (
            await tx.query(
              "SELECT id,kind,affected_count,created_at,email_status,unfamiliar_network FROM app.account_security_events WHERE user_id=$1 AND created_at>now()-interval '90 days' ORDER BY created_at DESC,id DESC LIMIT 20",
              [a.id],
            )
          ).rows;
          return {
            data: sessions.map(({ user_agent, ...s }) => ({
              ...s,
              ...describeDevice(user_agent),
              location: null,
            })),
            events,
          } as LoginSessionsResponse;
        },
        true,
      );
      res.json(result);
    }),
  );
  router.post('/activity', (_req, res) => {
    res.json({ idle_expires_at: res.locals.actor.idle_expires_at ?? null });
  });
  router.post(
    '/logout-others',
    asyncRoute(async (_req, res) => {
      const a = res.locals.actor;
      const ended = await transaction(
        pool,
        a.context,
        async (tx) =>
          (await tx.query('SELECT app.end_account_sessions($1,NULL,true) AS ended', [a.sessionId]))
            .rows[0].ended,
      );
      res.json({ ended, current_session_ended: false });
    }),
  );
  router.delete(
    '/:id',
    asyncRoute(async (req, res) => {
      const id = uuid.parse(req.params.id),
        a = res.locals.actor;
      const ended = await transaction(
        pool,
        a.context,
        async (tx) =>
          (
            await tx.query('SELECT app.end_account_sessions($1,$2,false) AS ended', [
              a.sessionId,
              id,
            ])
          ).rows[0].ended,
      );
      if (!ended) throw notFound();
      res.json({ ended, current_session_ended: id === a.sessionId });
    }),
  );
  return router;
}
