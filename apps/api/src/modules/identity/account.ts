import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { asyncRoute } from '../../lib/errors.js';
import { transaction } from '../../lib/db.js';

export function accountRouter(pool: pg.Pool) {
  const router = Router();
  router.get(
    '/credentials',
    asyncRoute(async (req, res) => {
      z.object({}).strict().parse(req.query);
      res.json(
        await transaction(
          pool,
          res.locals.actor.context,
          async (tx) =>
            (await tx.query('SELECT app.account_credentials() AS credentials')).rows[0].credentials,
          true,
        ),
      );
    }),
  );
  return router;
}
